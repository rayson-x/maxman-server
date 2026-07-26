import assert from "node:assert/strict";
import test from "node:test";
import type { Job } from "bullmq";
import { createWorkerJobProcessor } from "./workerProcessor.js";

function deletionJob(data: unknown): Job {
  return {
    id: "delete-1",
    name: "data_deletion",
    data,
  } as Job;
}

test("data_deletion jobs execute the accepted deletion scope", async () => {
  const calls: unknown[] = [];
  const processor = createWorkerJobProcessor({
    runOrchestratedJob: async () => {
      throw new Error("data deletion must not enter the analysis orchestrator");
    },
    executeDeletion: async (userId, scope) => {
      calls.push({ userId, scope });
      return { objectsDeleted: 1, objectsFailed: [], rowsDeleted: 1 };
    },
  });

  const result = await processor(
    deletionJob({ userId: "user-a", scope: { kind: "single_photo", photoId: "photo-a" } }),
  );

  assert.deepEqual(calls, [
    { userId: "user-a", scope: { kind: "single_photo", photoId: "photo-a" } },
  ]);
  assert.deepEqual(result, { objectsDeleted: 1, objectsFailed: [], rowsDeleted: 1 });
});

test("data_deletion object failures reject the job so BullMQ can retry it", async () => {
  const processor = createWorkerJobProcessor({
    runOrchestratedJob: async () => {
      throw new Error("unexpected orchestrator call");
    },
    executeDeletion: async () => ({
      objectsDeleted: 0,
      objectsFailed: ["raw/user-a/front.jpg"],
      rowsDeleted: 0,
    }),
  });

  await assert.rejects(
    processor(deletionJob({ userId: "user-a", scope: { kind: "all_photos" } })),
    /raw\/user-a\/front\.jpg/,
  );
});

test("malformed data_deletion payloads reject instead of being acknowledged", async () => {
  const processor = createWorkerJobProcessor({
    runOrchestratedJob: async () => {
      throw new Error("unexpected orchestrator call");
    },
    executeDeletion: async () => {
      throw new Error("malformed payload must be rejected before deletion");
    },
  });

  await assert.rejects(
    processor(deletionJob({ userId: "user-a", scope: { kind: "single_photo" } })),
    /invalid data_deletion payload/i,
  );
});
