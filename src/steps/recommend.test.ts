import assert from "node:assert/strict";
import { after, test } from "node:test";

import { createContainer } from "../app/container.js";
import type { StepDeps } from "./types.js";
import { recommendStep } from "./recommend.js";

const container = createContainer({ withQueues: false, withProviders: false });
const sessionIds: string[] = [];

after(async () => {
  await container.prisma.user.deleteMany({ where: { deviceSessionId: { in: sessionIds } } });
  await container.shutdown();
});

test("首轮候选全被过滤时仍公开风格方向并记录付费调用", async () => {
  const deviceSessionId = `recommend-partial-${Date.now()}`;
  sessionIds.push(deviceSessionId);
  const user = await container.prisma.user.create({
    data: { deviceSessionId, ageConfirmed18Plus: true },
  });
  const plan = await container.prisma.appearancePlan.create({
    data: { userId: user.id, track: "short_term", generationSeed: 42 },
  });
  const job = await container.prisma.analysisJob.create({
    data: { userId: user.id, planId: plan.id, jobType: "initial_analysis", status: "recommending" },
  });
  const provider = {
    name: "test-multimodal-provider",
    version: "test-v1",
    source: "multimodal_agent" as const,
    async recommend() {
      return {
        candidates: [{
          providerCandidateKey: "invalid-candidate",
          nameZh: "不合格候选",
          description: "仅用于验证过滤后的部分成功",
          modelRationale: "不会公开为发型候选",
          visualDirection: "改变脸型骨骼比例",
          rank: 1,
        }],
        firstRound: {
          faceAnalysis: { narrative: "首轮结论仍应保留", structuredSemantic: {} },
          styleRecommendations: [
            { id: "clean-fit", nameZh: "干净简约", description: "利落基础", rationale: "适合日常" },
            { id: "soft-youth", nameZh: "轻柔少年", description: "自然层次", rationale: "保留亲和感" },
            { id: "urban-commuter", nameZh: "都市通勤", description: "简洁克制", rationale: "适配正式场景" },
          ],
        },
        callId: "provider-call-1",
        latencyMs: 12,
        provider: "test-provider",
        modelVersion: "test-model",
      };
    },
  };
  const deps = {
    prisma: container.prisma,
    providers: { hairstyleRecommendation: provider, outfitRecommendation: provider },
  } as unknown as StepDeps;

  const outcome = await recommendStep.run({
    frontPhotoStorageKey: "tests/recommend-partial.jpg",
    vision: {
      geometry: { faceShape: "round", confidence: "high", evidence: {}, source: "client_mediapipe" },
      hairSignals: { hairline: "normal", volume: "medium", selfReportedHairLossConcern: false },
      clientSignals: {},
      hasFullBody: false,
    },
  }, { jobId: job.id, userId: user.id, planId: plan.id }, deps);

  assert.equal(outcome.status, "completed_partial");
  if (outcome.status !== "completed_partial") return;
  assert.equal(outcome.data.candidates.length, 0);
  assert.equal(outcome.data.firstRound?.styleRecommendations.length, 3);
  const audit = await container.prisma.workflowRun.findFirst({
    where: { jobId: job.id, stepName: "S2_S3_multimodal_agent" },
  });
  assert.equal(audit?.provider, "test-provider");
  assert.equal(audit?.modelVersion, "test-model");
  assert.deepEqual(audit?.qualityResult, { providerCallId: "provider-call-1" });
});
