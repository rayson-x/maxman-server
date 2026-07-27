import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../app/server.js";
import { createContainer, type AppContainer } from "../app/container.js";
import { SESSION_COOKIE_NAME } from "../services/sessionService.js";

let container: AppContainer;
let app: FastifyInstance;
const sessionIds: string[] = [];

before(async () => {
  container = createContainer({ withQueues: false, withProviders: false });
  app = await buildApp({ container, logger: false });
});

after(async () => {
  if (sessionIds.length > 0) {
    await container.prisma.user.deleteMany({ where: { deviceSessionId: { in: sessionIds } } });
  }
  await app.close();
});

test("style direction must be selected before outfit generation and must come from the first round", async () => {
  const session = await app.inject({ method: "POST", url: "/auth/device-session" });
  assert.equal(session.statusCode, 201);
  const deviceSessionId = session.json().deviceSessionId as string;
  sessionIds.push(deviceSessionId);
  const user = await container.prisma.user.findUniqueOrThrow({ where: { deviceSessionId } });
  const plan = await container.prisma.appearancePlan.create({
    data: { userId: user.id, track: "short_term", generationSeed: 42 },
  });
  await container.prisma.analysisJob.create({
    data: {
      userId: user.id,
      planId: plan.id,
      jobType: "initial_analysis",
      status: "completed",
      completedAt: new Date(),
      partialResult: {
        styleRecommendations: [
          { id: "clean-fit", nameZh: "干净简约", description: "基础利落", rationale: "适合日常" },
        ],
      },
    },
  });
  const headers = { cookie: `${SESSION_COOKIE_NAME}=${deviceSessionId}`, "idempotency-key": "style-direction-e2e-0001" };

  const blocked = await app.inject({ method: "POST", url: `/plans/${plan.id}/outfit-previews`, headers });
  assert.equal(blocked.statusCode, 422);
  assert.equal(blocked.json().error, "style_not_selected");

  const invented = await app.inject({
    method: "POST",
    url: `/plans/${plan.id}/select-style-direction`,
    headers,
    payload: { styleId: "invented-style" },
  });
  assert.equal(invented.statusCode, 422);

  const selected = await app.inject({
    method: "POST",
    url: `/plans/${plan.id}/select-style-direction`,
    headers,
    payload: { styleId: "clean-fit" },
  });
  assert.equal(selected.statusCode, 200);
  assert.equal(selected.json().style.id, "clean-fit");

  const nextGate = await app.inject({ method: "POST", url: `/plans/${plan.id}/outfit-previews`, headers });
  assert.equal(nextGate.statusCode, 422);
  assert.equal(nextGate.json().error, "hairstyle_not_selected");
});

test("style and hairstyle are selected atomically and cannot cross the first-round pairing", async () => {
  const session = await app.inject({ method: "POST", url: "/auth/device-session" });
  assert.equal(session.statusCode, 201);
  const deviceSessionId = session.json().deviceSessionId as string;
  sessionIds.push(deviceSessionId);
  const user = await container.prisma.user.findUniqueOrThrow({ where: { deviceSessionId } });
  const plan = await container.prisma.appearancePlan.create({
    data: { userId: user.id, track: "short_term", generationSeed: 43 },
  });
  await container.prisma.analysisJob.create({
    data: {
      userId: user.id,
      planId: plan.id,
      jobType: "initial_analysis",
      status: "completed",
      completedAt: new Date(),
      partialResult: {
        styleRecommendations: [
          { id: "clean-fit", nameZh: "干净简约", description: "基础利落", rationale: "适合日常" },
          { id: "soft-youth", nameZh: "轻柔少年", description: "自然层次", rationale: "保留亲和感" },
          { id: "urban-commuter", nameZh: "都市通勤", description: "简洁克制", rationale: "适配正式场景" },
        ],
      },
    },
  });
  const set = await container.prisma.recommendationSet.create({
    data: {
      planId: plan.id,
      kind: "hairstyle",
      status: "ready",
      computationKey: `style-pair-${plan.id}`,
      inputFingerprint: "test",
      source: "multimodal_agent",
      capabilityStatus: {} as never,
    },
  });
  const [cleanHair, softHair] = await Promise.all([
    container.prisma.recommendationCandidate.create({
      data: {
        setId: set.id, providerCandidateKey: "clean", nameZh: "法式碎盖", description: "自然碎发",
        modelRationale: "利落", rank: 1, visualDirection: "自然短碎发", renderInstruction: "自然短碎发",
        styleDirectionId: "clean-fit",
      },
    }),
    container.prisma.recommendationCandidate.create({
      data: {
        setId: set.id, providerCandidateKey: "soft", nameZh: "微碎盖", description: "轻薄层次",
        modelRationale: "亲和", rank: 2, visualDirection: "轻薄碎发", renderInstruction: "轻薄碎发",
        styleDirectionId: "soft-youth",
      },
    }),
  ]);
  const headers = { cookie: `${SESSION_COOKIE_NAME}=${deviceSessionId}` };

  const rejected = await app.inject({
    method: "POST",
    url: `/plans/${plan.id}/select-style-hairstyle`,
    headers,
    payload: { styleId: "clean-fit", candidateId: softHair.id },
  });
  assert.equal(rejected.statusCode, 422);
  assert.equal(rejected.json().error, "candidate_not_in_selected_style");
  const unchanged = await container.prisma.appearancePlan.findUniqueOrThrow({ where: { id: plan.id } });
  assert.equal(unchanged.selectedStyle, null);
  assert.equal(unchanged.selectedHairstyleId, null);

  const accepted = await app.inject({
    method: "POST",
    url: `/plans/${plan.id}/select-style-hairstyle`,
    headers,
    payload: { styleId: "clean-fit", candidateId: cleanHair.id },
  });
  assert.equal(accepted.statusCode, 200);
  const selected = await container.prisma.appearancePlan.findUniqueOrThrow({ where: { id: plan.id } });
  assert.equal((selected.selectedStyle as { id: string }).id, "clean-fit");
  assert.equal(selected.selectedHairstyleId, cleanHair.id);

  const incompatibleSwitch = await app.inject({
    method: "POST",
    url: `/plans/${plan.id}/select-style-direction`,
    headers,
    payload: { styleId: "soft-youth" },
  });
  assert.equal(incompatibleSwitch.statusCode, 422);
  assert.equal(incompatibleSwitch.json().error, "candidate_not_in_selected_style");
  const stillSelected = await container.prisma.appearancePlan.findUniqueOrThrow({ where: { id: plan.id } });
  assert.equal((stillSelected.selectedStyle as { id: string }).id, "clean-fit");
  assert.equal(stillSelected.selectedHairstyleId, cleanHair.id);
});
