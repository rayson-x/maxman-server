## Why

`add-mvp1-core-flow` specifies the full server (Fastify routes, Prisma schema, BullMQ queues, business logic) but implementation of that hadn't started. Before building the REST/DB/queue layer, we needed to de-risk the highest-uncertainty part of the whole system first: **does the agent+tool+provider architecture from `add-mvp1-core-flow` design.md decision 16 actually work, and which vendors are viable for each capability?**

This change is a standalone spike that answers that question empirically — it builds and validates the `providers/` + `workflows`-equivalent (Mastra agent/tools) layer in isolation, with real vendor credentials, before the Fastify/Prisma/BullMQ scaffolding exists. It intentionally does NOT touch REST routes, the database, or queues (those remain `add-mvp1-core-flow`'s job); it produces the `AppearanceAgentDeps`-shaped module that the future Fastify service layer will construct and inject.

## What Changes

- A `src/features/appearance-agent/` feature module built with explicit dependency injection (composition root pattern) instead of a service-locator singleton — every tool and the agent itself receive their provider dependencies as constructor arguments.
- Seven Mastra tools covering: vision analysis, img2img editing, clothing swap, illustrative text-to-image, catalog-constrained direction recommendation, unconstrained direction suggestion, and adversarial review between the two.
- Six provider capability categories (`VisionAnalysisProvider`, `ImageEditProvider`, `ClothingSwapProvider`, `TextToImageProvider`, `TextPlanningProvider`, `FreeRecommendationProvider`, `AdversarialReviewProvider` — seven, correcting count), each config-selectable per `add-mvp1-core-flow` design.md decision 16, with real vendor implementations empirically tested against live APIs (not stubs).
- A human-curated `CandidateTaskCatalog` seed data module (hair + outfit_accessory domains) that constrains `TextPlanningProvider`'s output, matching `add-mvp1-core-flow` design.md decision 15.
- A durable, file-backed task ledger (`recordSubmitted`/`recordResult`/`resumeTask`) for every Volcengine async call, plus a shared rate limiter enforcing Volcengine's ~2 QPS cap across all callers.
- Empirical vendor findings that update `add-mvp1-core-flow`'s stale "Open Questions" section (several candidates are now confirmed working, one is confirmed non-viable).

## Impact

- Affected code: new `server/src/features/appearance-agent/`, `server/src/lib/{taskLedger,rateLimiter,ossUpload}.ts`, `server/src/config/env.ts`.
- Affected specs: new capability `appearance-agent-tools` (this change). No modification to `add-mvp1-core-flow`'s specs — that proposal's Fastify/Prisma/BullMQ scope is unaffected and will consume this module's `getAppearanceAgent()` export once built.
- Follow-up: `add-mvp1-core-flow`'s Open Questions section should be updated to reflect the vendor findings here (tracked as a task in this change, not a spec delta on that change).
