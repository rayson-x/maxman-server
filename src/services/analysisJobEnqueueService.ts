import type { Queue } from "bullmq";
import type { PrismaClient } from "../generated/prisma/client.js";

export type RecoverableEnqueueResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * AnalysisJob row 是最小 outbox；其 id 同时也是稳定的 BullMQ jobId。
 *
 * Queue.add 的结果不确定时，调用方可以重放同一个 created job。BullMQ 会按
 * jobId 返回同一任务，而不会再生成一个会重复调用供应商的队列任务。
 */
export async function enqueueCreatedAnalysisJob(params: {
  prisma: PrismaClient;
  queue: Queue;
  jobName: string;
  job: { id: string; errorReason: string | null };
  payload: Record<string, unknown>;
}): Promise<RecoverableEnqueueResult> {
  try {
    await params.queue.add(
      params.jobName,
      { ...params.payload, jobId: params.job.id },
      { jobId: params.job.id },
    );
    if (params.job.errorReason) {
      await params.prisma.analysisJob.update({
        where: { id: params.job.id },
        data: { errorReason: null },
      });
    }
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await params.prisma.analysisJob.update({
      where: { id: params.job.id },
      data: { errorReason: `queue_enqueue_failed: ${message}` },
    });
    return { ok: false, error: message };
  }
}
