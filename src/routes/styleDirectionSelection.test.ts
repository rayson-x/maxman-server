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

test("hairstyle selection follows style selection and invalidates downstream wardrobe", async () => {
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
  const hairSet = await container.prisma.recommendationSet.create({
    data: {
      planId: plan.id,
      kind: "hairstyle",
      status: "ready",
      computationKey: `hairstyle-selection-${plan.id}`,
      inputFingerprint: "test",
      source: "multimodal_agent",
      capabilityStatus: {} as never,
    },
  });
  const [cleanHair, cleanHairAlternative, softHair] = await Promise.all([
    container.prisma.recommendationCandidate.create({
      data: {
        setId: hairSet.id, providerCandidateKey: "clean", nameZh: "法式碎盖", description: "自然碎发",
        modelRationale: "利落", rank: 1, visualDirection: "自然短碎发", renderInstruction: "自然短碎发",
        styleDirectionId: "clean-fit",
      },
    }),
    container.prisma.recommendationCandidate.create({
      data: {
        setId: hairSet.id, providerCandidateKey: "clean-alt", nameZh: "短碎发", description: "清爽短层次",
        modelRationale: "轻快", rank: 2, visualDirection: "清爽短碎发", renderInstruction: "清爽短碎发",
        styleDirectionId: "clean-fit",
      },
    }),
    container.prisma.recommendationCandidate.create({
      data: {
        setId: hairSet.id, providerCandidateKey: "soft", nameZh: "微碎盖", description: "轻薄层次",
        modelRationale: "亲和", rank: 3, visualDirection: "轻薄碎发", renderInstruction: "轻薄碎发",
        styleDirectionId: "soft-youth",
      },
    }),
  ]);
  const headers = { cookie: `${SESSION_COOKIE_NAME}=${deviceSessionId}` };

  const atomic = await app.inject({
    method: "POST",
    url: `/plans/${plan.id}/select-style-hairstyle`,
    headers,
    payload: { styleId: "clean-fit", candidateId: softHair.id },
  });
  assert.equal(atomic.statusCode, 410);
  assert.equal(atomic.json().error, "deprecated_atomic_selection");
  const unchanged = await container.prisma.appearancePlan.findUniqueOrThrow({ where: { id: plan.id } });
  assert.equal(unchanged.selectedStyle, null);
  assert.equal(unchanged.selectedHairstyleId, null);

  const style = await app.inject({
    method: "POST",
    url: `/plans/${plan.id}/select-style-direction`,
    headers,
    payload: { styleId: "clean-fit" },
  });
  assert.equal(style.statusCode, 200);
  // In the staged flow a pre-existing hairstyle set is superseded by the
  // style choice. This fixture represents the fresh set produced afterward.
  await container.prisma.recommendationSet.update({ where: { id: hairSet.id }, data: { status: "ready" } });

  const rejected = await app.inject({
    method: "POST",
    url: `/plans/${plan.id}/select-hairstyle`,
    headers,
    payload: { candidateId: softHair.id },
  });
  assert.equal(rejected.statusCode, 422);
  assert.equal(rejected.json().error, "candidate_not_in_selected_style");

  const accepted = await app.inject({
    method: "POST",
    url: `/plans/${plan.id}/select-hairstyle`,
    headers,
    payload: { candidateId: cleanHair.id },
  });
  assert.equal(accepted.statusCode, 200);
  const selected = await container.prisma.appearancePlan.findUniqueOrThrow({ where: { id: plan.id } });
  assert.equal((selected.selectedStyle as { id: string }).id, "clean-fit");
  assert.equal(selected.selectedHairstyleId, cleanHair.id);

  const outfitSet = await container.prisma.recommendationSet.create({
    data: {
      planId: plan.id,
      kind: "outfit",
      status: "ready",
      computationKey: `outfit-selection-${plan.id}`,
      inputFingerprint: "test",
      source: "multimodal_agent",
      capabilityStatus: {} as never,
    },
  });
  const outfit = await container.prisma.recommendationCandidate.create({
    data: {
      setId: outfitSet.id, providerCandidateKey: "outfit", nameZh: "简约通勤", description: "基础通勤组合",
      modelRationale: "利落", rank: 1, visualDirection: "简约通勤", renderInstruction: "简约通勤",
    },
  });
  const selectedOutfit = await app.inject({
    method: "POST",
    url: `/plans/${plan.id}/select-outfit`,
    headers,
    payload: { candidateId: outfit.id },
  });
  assert.equal(selectedOutfit.statusCode, 200);
  const preview = await container.prisma.generatedAsset.create({
    data: {
      userId: user.id,
      planId: plan.id,
      candidateId: outfit.id,
      recommendationSetId: outfitSet.id,
      kind: "outfit_preview",
      storageKey: `generated/${plan.id}/outfit.png`,
      provider: "test",
      disclosure: "AI 生成模拟效果",
    },
  });

  const changedHair = await app.inject({
    method: "POST",
    url: `/plans/${plan.id}/select-hairstyle`,
    headers,
    payload: { candidateId: cleanHairAlternative.id },
  });
  assert.equal(changedHair.statusCode, 200);
  const afterHairChange = await container.prisma.appearancePlan.findUniqueOrThrow({ where: { id: plan.id } });
  assert.equal(afterHairChange.selectedHairstyleId, cleanHairAlternative.id);
  assert.equal(afterHairChange.selectedOutfitId, null);
  const hairInvalidatedOutfit = await container.prisma.recommendationSet.findUniqueOrThrow({ where: { id: outfitSet.id } });
  assert.equal(hairInvalidatedOutfit.status, "superseded");
  assert.equal((await container.prisma.generatedAsset.findUniqueOrThrow({ where: { id: preview.id } })).status, "invalidated");

  const styleSwitch = await app.inject({
    method: "POST",
    url: `/plans/${plan.id}/select-style-direction`,
    headers,
    payload: { styleId: "soft-youth" },
  });
  assert.equal(styleSwitch.statusCode, 200);
  const invalidated = await container.prisma.appearancePlan.findUniqueOrThrow({ where: { id: plan.id } });
  assert.equal((invalidated.selectedStyle as { id: string }).id, "soft-youth");
  assert.equal(invalidated.selectedHairstyleId, null);
  assert.equal(invalidated.selectedOutfitId, null);
  const [supersededHair, supersededOutfit] = await Promise.all([
    container.prisma.recommendationSet.findUniqueOrThrow({ where: { id: hairSet.id } }),
    container.prisma.recommendationSet.findUniqueOrThrow({ where: { id: outfitSet.id } }),
  ]);
  assert.equal(supersededHair.status, "superseded");
  assert.equal(supersededOutfit.status, "superseded");
});
