import type { PrismaClient } from "../generated/prisma/client.js";
import type { JobStatus, JobType } from "../generated/prisma/enums.js";
import { Prisma } from "../generated/prisma/client.js";

/**
 * AnalysisJob 状态机与仓储（tasks 7.1）。
 *
 * 两点与前一份 spec 不同（design.md 决策 16 与 job_type 重定义）：
 *
 * 1. **新增 `completed_partial` 态。** 渐进式推送下「全或无」自相矛盾——
 *    已经推给用户的图收不回来。所以「3 张里出了 2 张」必须能如实表达，
 *    既不是 completed（会让用户以为只有 2 个方案），也不是 failed（那 2 张是可用的）。
 *
 * 2. **状态集按 job_type 收窄。** 前一份 spec 让全部 4 种 job_type 共用一条
 *    线性状态机，导致 `input_moderating` 这类状态对多数 job 是空转。现在每个
 *    job_type 声明自己实际会经过的状态，非法跃迁会被拒绝而不是静默写入。
 */

/** 终态：不可再跃迁 */
const TERMINAL: JobStatus[] = ["completed", "completed_partial", "failed", "cancelled"];

/**
 * 各 job_type 允许的状态序列。
 * `initial_analysis` 才真正经过输入审核（用户刚上传照片与自由文本）；
 * 其余 job_type 的照片早已审核通过，让它们空转一遍 input_moderating 只会
 * 让状态含义变模糊。
 */
const ALLOWED_FLOW: Record<JobType, JobStatus[]> = {
  initial_analysis: ["created", "input_moderating", "analyzing", "recommending", "rendering"],
  hairstyle_recommendation: ["created", "recommending"],
  hairstyle_preview_generation: ["created", "rendering"],
  wardrobe_recommendation: ["created", "recommending"],
  outfit_preview_generation: ["created", "rendering"],
  plan_materialization: ["created", "materializing"],
  stage_unlock_generation: ["created", "rendering", "quality_checking"],
  user_regeneration: ["created", "rendering", "quality_checking"],
  progress_recheck: ["created", "input_moderating", "analyzing", "rendering", "quality_checking"],
};

export type TransitionResult =
  | { ok: true; status: JobStatus }
  | { ok: false; reason: string };

export function createAnalysisJobRepository(prisma: PrismaClient) {
  return {
    async create(params: { userId: string; jobType: JobType; planId?: string; stageId?: string; idempotencyKey?: string }) {
      if (params.idempotencyKey) {
        const key = {
          userId: params.userId,
          jobType: params.jobType,
          idempotencyKey: params.idempotencyKey,
        };
        try {
          return await prisma.analysisJob.upsert({
            where: { userId_jobType_idempotencyKey: key },
            create: { ...key, planId: params.planId, stageId: params.stageId, status: "created" },
            update: {},
          });
        } catch (error) {
          /*
           * upsert 对**并发插入**不是原子的：两个请求都查不到、都走 create，
           * 一个撞唯一约束 → P2002 → 500。
           *
           * 这不是边缘情况——React 严格模式下 effect 必然跑两次，
           * 于是每个浏览器首次分析都会打出一次 500，客户端随即降级到模拟数据，
           * 用户看到一份"成功"的假方案。实测复现率 100%。
           * 幂等键的语义本就是"同一个键只应有一个 job"，撞了就把已存在那条读回来。
           */
          if (
            error instanceof Prisma.PrismaClientKnownRequestError
            && error.code === "P2002"
          ) {
            const existing = await prisma.analysisJob.findUnique({
              where: { userId_jobType_idempotencyKey: key },
            });
            if (existing) return existing;
          }
          throw error;
        }
      }
      return prisma.analysisJob.create({
        data: {
          userId: params.userId,
          jobType: params.jobType,
          planId: params.planId,
          stageId: params.stageId,
          idempotencyKey: params.idempotencyKey,
          status: "created",
        },
      });
    },

    async get(jobId: string) {
      return prisma.analysisJob.findUnique({ where: { id: jobId } });
    },

    /**
     * 状态跃迁。非法跃迁**返回失败而不是抛异常**——调用方通常是队列 worker，
     * 一个非法跃迁不该让整个 job 崩掉，但必须能被记录和观察到。
     */
    async transition(jobId: string, next: JobStatus): Promise<TransitionResult> {
      const job = await prisma.analysisJob.findUnique({ where: { id: jobId } });
      if (!job) return { ok: false, reason: `job ${jobId} 不存在` };

      if (TERMINAL.includes(job.status)) {
        return { ok: false, reason: `job 已处于终态 ${job.status}，不可再跃迁到 ${next}` };
      }

      // 终态可从任何非终态进入（失败/取消随时可能发生）
      if (!TERMINAL.includes(next)) {
        const flow = ALLOWED_FLOW[job.jobType];
        const currentIdx = flow.indexOf(job.status);
        const nextIdx = flow.indexOf(next);
        if (nextIdx === -1) {
          return { ok: false, reason: `${job.jobType} 不经过状态 ${next}（允许：${flow.join(" → ")}）` };
        }
        // 只允许前进，不允许回退——回退意味着重跑，那应该新建 job 而不是复用
        if (nextIdx <= currentIdx) {
          return { ok: false, reason: `不允许从 ${job.status} 回退/停留到 ${next}` };
        }
      }

      await prisma.analysisJob.update({
        where: { id: jobId },
        data: {
          status: next,
          completedAt: TERMINAL.includes(next) ? new Date() : undefined,
        },
      });
      return { ok: true, status: next };
    },

    /** 标记完成。有缺失项时落 `completed_partial` 而非 `completed`（决策 16） */
    async complete(jobId: string, opts: { missing?: { item: string; reason: string }[] } = {}): Promise<TransitionResult> {
      const hasMissing = (opts.missing?.length ?? 0) > 0;
      const result = await this.transition(jobId, hasMissing ? "completed_partial" : "completed");
      if (result.ok && hasMissing) {
        const job = await prisma.analysisJob.findUnique({ where: { id: jobId } });
        const existing = (job?.partialResult ?? {}) as Record<string, unknown>;
        await prisma.analysisJob.update({
          where: { id: jobId },
          data: { partialResult: { ...existing, missing: opts.missing } as never },
        });
      }
      return result;
    },

    async fail(jobId: string, errorReason: string): Promise<TransitionResult> {
      const result = await this.transition(jobId, "failed");
      if (result.ok) {
        await prisma.analysisJob.update({ where: { id: jobId }, data: { errorReason } });
      }
      return result;
    },

    /** 增量合并部分结果，供渐进式推送使用（决策 12） */
    async mergePartialResult(jobId: string, patch: Record<string, unknown>): Promise<void> {
      const job = await prisma.analysisJob.findUnique({ where: { id: jobId } });
      const existing = (job?.partialResult ?? {}) as Record<string, unknown>;
      await prisma.analysisJob.update({
        where: { id: jobId },
        data: { partialResult: { ...existing, ...patch } as never },
      });
    },

    isTerminal(status: JobStatus): boolean {
      return TERMINAL.includes(status);
    },

    allowedFlowFor(jobType: JobType): JobStatus[] {
      return ALLOWED_FLOW[jobType];
    },
  };
}

export type AnalysisJobRepository = ReturnType<typeof createAnalysisJobRepository>;
