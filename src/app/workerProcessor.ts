import type { Job } from "bullmq";
import type {
  DataDeletionService,
  DeletionScope,
} from "../services/dataDeletionService.js";

type WorkerProcessorDependencies = {
  runOrchestratedJob: (job: Job) => Promise<unknown>;
  executeDeletion: DataDeletionService["executeDeletion"];
};

type DataDeletionPayload = {
  userId: string;
  scope: DeletionScope;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseDataDeletionPayload(value: unknown): DataDeletionPayload {
  if (!value || typeof value !== "object") {
    throw new Error("invalid data_deletion payload");
  }

  const payload = value as { userId?: unknown; scope?: unknown };
  if (!isNonEmptyString(payload.userId) || !payload.scope || typeof payload.scope !== "object") {
    throw new Error("invalid data_deletion payload");
  }

  const scope = payload.scope as { kind?: unknown; photoId?: unknown; targetImageId?: unknown };
  switch (scope.kind) {
    case "single_photo":
      if (!isNonEmptyString(scope.photoId)) throw new Error("invalid data_deletion payload");
      return { userId: payload.userId, scope: { kind: scope.kind, photoId: scope.photoId } };
    case "single_target_image":
      if (!isNonEmptyString(scope.targetImageId)) throw new Error("invalid data_deletion payload");
      return {
        userId: payload.userId,
        scope: { kind: scope.kind, targetImageId: scope.targetImageId },
      };
    case "all_photos":
    case "all_generated_images":
    case "derived_features":
    case "profile":
    case "account":
      return { userId: payload.userId, scope: { kind: scope.kind } };
    default:
      throw new Error("invalid data_deletion payload");
  }
}

/**
 * Worker 的可测试分发边界。删除任务不属于 AI 编排任务，必须直接执行隐私清理；
 * 只要对象存储还有失败项就拒绝 job，让 BullMQ 按 attempts/backoff 重试。
 */
export function createWorkerJobProcessor(dependencies: WorkerProcessorDependencies) {
  return async function processWorkerJob(job: Job): Promise<unknown> {
    if (job.name !== "data_deletion") {
      return dependencies.runOrchestratedJob(job);
    }

    const payload = parseDataDeletionPayload(job.data);
    const result = await dependencies.executeDeletion(payload.userId, payload.scope);
    if (result.objectsFailed.length > 0) {
      throw new Error(
        `data_deletion failed to remove objects: ${result.objectsFailed.join(", ")}`,
      );
    }
    return result;
  };
}
