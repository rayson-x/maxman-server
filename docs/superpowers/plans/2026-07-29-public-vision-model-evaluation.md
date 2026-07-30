# Public Vision Model Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy a public anonymous questionnaire that compares responses from the currently usable vision models against twenty fixed repository benchmark images.

**Architecture:** A server-owned manifest and PostgreSQL run/response/rating records make the benchmark resumable. A text-analysis worker performs fixed, metered provider calls; public Fastify endpoints only read the prepared run, serve allowlisted images, and upsert the current device-session rating. The Next.js page keeps model identities blinded until all available responses for a sample are rated.

**Tech Stack:** Fastify, Prisma/PostgreSQL, BullMQ, AI SDK OpenAI-compatible providers, Next.js 16, React 19, TypeScript.

---

### Task 1: Persist a fixed evaluation run and safe sample manifest

**Files:**
- Create: `src/features/model-evaluation/catalog.ts`
- Create: `src/features/model-evaluation/service.ts`
- Create: `src/features/model-evaluation/service.test.ts`
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_public_vision_model_evaluation/migration.sql`

- [x] **Step 1: Write failing service tests**

```ts
test("creates one default run with twenty allowlisted samples and one result per configured model", async () => {
  const run = await service.ensureDefaultRun();
  assert.equal(run.samples.length, 20);
  assert.equal(new Set(run.samples.map((sample) => sample.assetPath)).size, 20);
  assert.equal(run.responses.length, 5 * 20);
});

test("rejects an image id that is not in the fixed manifest", () => {
  assert.throws(() => catalog.resolveAsset("../../etc/passwd"));
});
```

- [x] **Step 2: Run the focused test and confirm it fails because the evaluation module does not exist**

Run: `npm run build && node --test dist/features/model-evaluation/service.test.js`

- [x] **Step 3: Add the evaluation data model and catalog**

Create `ModelEvaluationRun`, `ModelEvaluationResponse`, and `ModelEvaluationRating` with response uniqueness by run/sample/model and rating uniqueness by response/user. Define a stable twenty-item catalog using only paths below the benchmark root; model descriptors are Zhipu GLM-4V Flash, GLM-4.6V, GLM-5V Turbo, Qwen-VL Plus, and Hunyuan Vision.

- [x] **Step 4: Implement the minimal service and migration**

`ensureDefaultRun()` creates the immutable run and all pending response rows once. `resolveAsset()` maps only catalog ids to files below the benchmark root. Add cascading user ratings so device-session deletion removes its answers.

- [x] **Step 5: Re-run focused test and typecheck** — `npx prisma generate`, focused tests (4/4), and `git diff --check` passed; the full typecheck was resource-limited and is deferred to the final build verification.

Run: `npx prisma generate && npm run build && node --test dist/features/model-evaluation/service.test.js`

### Task 2: Execute and meter the model matrix in the worker

**Files:**
- Create: `src/features/model-evaluation/runner.ts`
- Create: `src/features/model-evaluation/runner.test.ts`
- Modify: `src/worker.ts`
- Modify: `src/services/providerCostAccounting.ts`
- Create: `prisma/migrations/<timestamp>_vision_evaluation_pricing/migration.sql`
- Modify: `src/services/providerCostAccounting.test.ts`

- [x] **Step 1: Write failing runner tests**

```ts
test("records a completed metered response from provider usage", async () => {
  await runner.execute({ runId, responseId });
  assert.equal(response.status, "completed");
  assert.deepEqual(recordedOperation, {
    provider: "zhipu", operation: "model_evaluation", model: "glm-5v-turbo", status: "completed",
  });
});

test("a provider error marks only that model response unavailable", async () => {
  await runner.execute({ runId, responseId });
  assert.equal(response.status, "failed");
  assert.match(response.errorReason, /credential|provider/i);
});
```

- [x] **Step 2: Run the focused test and confirm it fails before the runner exists**

Run: `npm run build && node --test dist/features/model-evaluation/runner.test.js`

- [x] **Step 3: Implement one bounded vision request adapter**

The runner reads the catalog image as a data URL, submits the shared non-diagnostic JSON prompt through the descriptor's configured OpenAI-compatible endpoint, normalizes valid JSON without discarding raw text, and calls `recordActiveProviderOperation()` with operation `model_evaluation` on both success and failure.

- [x] **Step 4: Wire worker dispatch and pricing snapshot**

Teach the existing text-analysis worker to process `model_evaluation` jobs. Add price rules for models whose current official prices are known; preserve `unknown` for any provider with unverified price rather than publishing zero. Enqueue only pending or failed rows with stable BullMQ job ids.

- [x] **Step 5: Re-run focused tests** — Prisma generation, focused tests (17/17), and `git diff --check` passed; full typecheck remains deferred to final build verification because this host cannot complete it within 60 seconds.

Run: `npm run build && node --test dist/features/model-evaluation/runner.test.js dist/services/providerCostAccounting.test.js`

### Task 3: Expose a public session-aware blind-rating API

**Files:**
- Create: `src/routes/modelEvaluation.ts`
- Create: `src/routes/modelEvaluation.test.ts`
- Modify: `src/app/server.ts`

- [x] **Step 1: Write failing route tests**

```ts
test("returns model results in a stable blinded order until the session rates every completed response", async () => {
  const before = await app.inject({ method: "GET", url: "/model-evaluation" });
  assert.equal(before.json().samples[0].responses[0].model, undefined);
  await rateAllResponsesForSample();
  const after = await app.inject({ method: "GET", url: "/model-evaluation" });
  assert.equal(after.json().samples[0].revealed, true);
});

test("upserts a session rating without increasing aggregate count", async () => {
  await submitRating({ hairstyleAccuracy: 3 });
  await submitRating({ hairstyleAccuracy: 5 });
  assert.equal(await ratingCountForSession(), 1);
});
```

- [x] **Step 2: Run the focused test and confirm it fails before the route exists**

Run: `npm run build && node --test dist/routes/modelEvaluation.test.js`

- [x] **Step 3: Implement public read, image, and rating endpoints**

The read endpoint returns run progress, only allowlisted image ids, shuffled blinded responses, current-session selections, and aggregate metrics. The image endpoint accepts only a catalog id. The rating endpoint requires an existing device session and validates 1–5 scores plus a boolean unsafe flag; it upserts by response/user.

- [x] **Step 4: Register the route and verify privacy behavior**

Register after session handling. Ensure no response includes provider credential, session id, arbitrary filesystem path, or any endpoint that creates a run or accepts browser prompt/image input.

- [x] **Step 5: Re-run focused route test and typecheck** — focused route tests (4/4) and `git diff --check` passed; final full build remains the deployment gate on this constrained host.

Run: `npm run build && node --test dist/routes/modelEvaluation.test.js`

### Task 4: Deliver the public questionnaire and deployment trigger

**Files:**
- Create: `../client/app/model-evaluation/page.tsx`
- Create: `../client/lib/api/modelEvaluation.ts`
- Modify: `package.json`
- Create: `src/scripts/run-model-evaluation.ts`
- Modify: `docs/superpowers/plans/2026-07-29-public-vision-model-evaluation.md`

- [x] **Step 1: Write client helper tests or compile-time contract checks**

```ts
test("rating request sends only bounded scores and uses the anonymous device session", async () => {
  await saveRating(responseId, { hairstyleAccuracy: 4, foreheadAccuracy: 5, usefulness: 4, unsafe: false });
  assert.deepEqual(request.body, { hairstyleAccuracy: 4, foreheadAccuracy: 5, usefulness: 4, unsafe: false });
});
```

- [x] **Step 2: Run the client verification and confirm it fails until the helper exists**

Run: `npm run build` in `client/`

- [x] **Step 3: Implement the page**

Ensure the device session, poll prepared results, show one catalog image and blinded response cards, save ratings, reveal model identities only after all completed cards are scored, and show the aggregate comparison with token/cost labels. Pending and unavailable responses must be visibly distinct.

- [x] **Step 4: Add the one-off server run command**

The command calls `ensureDefaultRun()`, enqueues missing evaluation responses to text-analysis, and prints run id and pending count. It never accepts a user image or model name.

- [ ] **Step 5: Build both applications and run focused tests** — deferred to the final deployment gate; this host has not completed a full TypeScript build within the 60-second resource limit.

Run: `npm run build && node --test dist/features/model-evaluation/*.test.js dist/routes/modelEvaluation.test.js` in `server/`; then `npm run build` in `client/`.

### Task 5: Deploy, execute the first matrix, and verify the questionnaire

**Files:**
- Modify: `.scratch/public-vision-model-evaluation/issues/04-deploy-first-evaluation.md`

- [ ] **Step 1: Apply migrations and restart the existing BetterMeet API and worker processes**

Run `npx prisma migrate deploy`, restart only `node dist/index.js` and `node dist/worker.js`, then verify `/health` reports database and Redis healthy.

- [ ] **Step 2: Enqueue the fixed evaluation run**

Run `npm run model-evaluation:run`; wait until all 20 responses for each usable model reach a terminal state. Do not restart or stop Paseo.

- [ ] **Step 3: Exercise a fresh public session**

Open `/model-evaluation`, submit one rating, refresh, and confirm the selected score and aggregate count remain visible.

- [ ] **Step 4: Run full verification and update ticket status**

Run `npm test` in `server/`, `npm run build` in `client/`, and `git diff --check`. Mark each local ticket complete only after its acceptance criteria have fresh evidence.
