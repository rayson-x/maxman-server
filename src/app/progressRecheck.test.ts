import assert from "node:assert/strict";
import test from "node:test";

import { createContainer } from "./container.js";
import { createJobOrchestrator } from "./jobOrchestrator.js";

test("progress recheck uses item evidence, rolls back the ledger, and stays free", async () => {
  const container = createContainer({ withQueues: false, withProviders: false });
  const prefix = `progress-recheck-${Date.now()}`;
  try {
    const user = await container.prisma.user.create({
      data: { deviceSessionId: prefix, ageConfirmed18Plus: true },
    });
    const plan = await container.prisma.appearancePlan.create({
      data: {
        userId: user.id,
        track: "short_term",
        generationSeed: 42,
        stages: {
          create: [{ stageIndex: 0, windowLabel: "当天", status: "active", unlockRule: {} }],
        },
      },
      include: { stages: true },
    });
    const task = await container.prisma.stageTask.create({
      data: {
        stageId: plan.stages[0].id,
        domain: "face_grooming",
        priority: "core",
        evidenceBasis: "visual_detected",
        title: "剃净胡须",
        changeDescription: "胡须剃干净",
        status: "done",
      },
    });
    const entry = await container.prisma.changeManifestEntry.create({
      data: {
        planId: plan.id,
        stageId: plan.stages[0].id,
        sourceTaskId: task.id,
        domain: task.domain,
        changeDescription: task.changeDescription!,
      },
    });
    const progressPhoto = await container.prisma.userPhoto.create({
      data: {
        userId: user.id,
        photoType: "progress",
        storageKey: `raw/${user.id}/progress.jpg`,
        moderationStatus: "passed",
      },
    });
    const job = await container.prisma.analysisJob.create({
      data: { userId: user.id, planId: plan.id, jobType: "progress_recheck" },
    });

    container.providers.vision = {
      name: "progress-verifier-fixture",
      async analyze() {
        return {
          provider: "fixture",
          model: "fixture",
          rawText: JSON.stringify({
            verdicts: [
              {
                entryId: entry.id,
                status: "not_completed",
                reason: "照片中仍可见胡须",
              },
            ],
          }),
          latencyMs: 1,
        };
      },
    };

    const outcome = await createJobOrchestrator(container).run("progress_recheck", {
      jobId: job.id,
      userId: user.id,
      planId: plan.id,
      progressPhotoStorageKey: progressPhoto.storageKey,
    });

    assert.equal(outcome.status, "completed");
    assert.equal(
      (await container.prisma.changeManifestEntry.findUniqueOrThrow({ where: { id: entry.id } }))
        .verificationStatus,
      "rolled_back",
    );
    assert.equal(
      (await container.prisma.stageTask.findUniqueOrThrow({ where: { id: task.id } })).status,
      "pending",
    );
    assert.equal(
      (await container.prisma.appearancePlan.findUniqueOrThrow({ where: { id: plan.id } }))
        .planVersion,
      2,
    );
    assert.equal(
      await container.prisma.targetImage.count({ where: { planId: plan.id } }),
      0,
      "阶段 0 按设计没有目标图，不应为校准额外生成",
    );
    assert.equal(
      await container.prisma.photoAccessLog.count({
        where: { storageKey: progressPhoto.storageKey, accessorType: "system_provider" },
      }),
      1,
    );
  } finally {
    await container.prisma.user.deleteMany({ where: { deviceSessionId: prefix } });
    await container.shutdown();
  }
});
