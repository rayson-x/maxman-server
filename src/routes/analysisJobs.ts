import type { FastifyInstance, FastifyRequest } from "fastify";
import { acceptedPhotoModerationStatuses, photoModerationWhere } from "../lib/photoModerationGate.js";
import { requireUser } from "../plugins/session.js";
import { env } from "../config/env.js";
import { createAnalysisJobRepository } from "../repositories/analysisJobRepository.js";
import { QUEUE_NAMES } from "../lib/queues.js";
import { isAdultEligible } from "../lib/ageEligibility.js";
import { enqueueCreatedAnalysisJob } from "../services/analysisJobEnqueueService.js";

/**
 * Job 触发与轮询（tasks 7.2-7.5, 7.7-7.8）。
 *
 * 三个 job 对应流程里两次同步用户选择切开的三段（design.md job_type 重定义）：
 *   POST /analysis-jobs                     → initial_analysis（S1-首轮选择数据，不自动出发型图）
 *   POST /plans/:id/hairstyle-previews      → hairstyle_preview_generation（选定风格后）
 *   POST /plans/:id/outfit-previews         → outfit_preview_generation（双源：选定发型后、选定穿搭前）
 *   POST /plans/:id/materialize             → plan_materialization（S5，选定穿搭后）
 *
 * 前一份 spec 想用一个 `full_analysis` 一口气跑完，但流程中间有用户选择，
 * 物理上不可能连续执行。
 */

type CompletenessIssue = { field: string; message: string };

function idempotencyKeyFrom(req: FastifyRequest): string | null {
  const value = req.headers["idempotency-key"];
  if (typeof value !== "string") return null;
  const key = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(key) ? key : null;
}

/** initial_analysis 的前置校验（tasks 7.2）。缺什么说清楚，不要只回一句"数据不完整" */
async function checkInitialAnalysisReadiness(
  prisma: FastifyInstance["container"]["prisma"],
  userId: string,
): Promise<CompletenessIssue[]> {
  const issues: CompletenessIssue[] = [];

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { ageConfirmed18Plus: true, birthDate: true },
  });
  if (!user || !isAdultEligible(user)) {
    issues.push({
      field: "ageEligibility",
      message: "本服务仅面向已满 18 岁且已明确确认年龄的用户",
    });
  }

  const profile = await prisma.appearanceProfile.findUnique({ where: { userId } });
  if (!profile) {
    issues.push({ field: "questionnaire", message: "尚未提交完整问卷" });
  } else {
    if (!profile.budgetTier) issues.push({ field: "budgetTier", message: "缺少预算档位" });
    if (profile.domainSelections.length === 0) issues.push({ field: "domainSelections", message: "尚未选择改善领域" });
  }

  const faceConsent = await prisma.consentRecord.findFirst({
    where: { userId, consentType: "face_processing", revokedAt: null },
  });
  if (!faceConsent) issues.push({ field: "consent", message: "尚未取得人脸信息处理同意" });

  const frontPhoto = await prisma.userPhoto.findFirst({
    where: { userId, photoType: "front", deletionStatus: "active" },
  });
  if (!frontPhoto) {
    issues.push({ field: "frontPhoto", message: "缺少正面照" });
  } else if (frontPhoto.moderationStatus === "rejected") {
    issues.push({ field: "frontPhoto", message: "正面照未通过内容审核，请重新上传" });
  } else if (!acceptedPhotoModerationStatuses().includes(frontPhoto.moderationStatus)) {
    // 走中心闸门而不是本地重新判一遍：这个门槛曾散落在 6 处，改一处漏一处，
    // 表现为「路由放行、某个 step 说找不到照片」这类自相矛盾的失败。
    // 放行 pending 不等于假装审核过——S1 会如实写下 photoVerdicts: deferred_no_provider。
    issues.push({ field: "frontPhoto", message: "正面照尚未通过内容审核，请稍后重试" });
  }

  return issues;
}

export async function registerAnalysisJobRoutes(app: FastifyInstance): Promise<void> {
  const { prisma, queues } = app.container;
  const jobs = createAnalysisJobRepository(prisma);

  /**
   * AnalysisJob.id 同时作为 BullMQ jobId：投递结果不确定或客户端重放时，
   * BullMQ 会返回同一个任务，而不是再造一条会重复调用供应商的任务。
   *
   * DB row 先于投递创建，相当于一个最小 outbox。投递失败时 row 保持 created，
   * 但记录错误；下一次相同请求必须重新投递它，不能只返回“已复用”。
   */
  async function enqueueCreatedJob(
    queueName: keyof typeof queues.queues,
    jobName: string,
    job: { id: string; errorReason: string | null },
    payload: Record<string, unknown>,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    return enqueueCreatedAnalysisJob({
      prisma,
      queue: queues.queues[queueName],
      jobName,
      job,
      payload,
    });
  }

  async function checkGenerationCapacity(userId: string): Promise<
    { ok: true } | { ok: false; cap: number; retryAfterSeconds: number }
  > {
    const oneHourAgo = new Date(Date.now() - 3600_000);
    const recentGenerations = await prisma.analysisJob.count({
      where: {
        userId,
        jobType: {
          in: [
            "initial_analysis",
            "hairstyle_recommendation",
            "wardrobe_recommendation",
            "user_regeneration",
            "outfit_preview_generation",
            "stage_unlock_generation",
          ],
        },
        createdAt: { gte: oneHourAgo },
      },
    });
    const configuredCap = Number(process.env.GENERATION_HOURLY_CAP ?? "3");
    const cap = Number.isInteger(configuredCap) && configuredCap > 0 ? configuredCap : 3;
    return recentGenerations >= cap
      ? { ok: false, cap, retryAfterSeconds: 600 }
      : { ok: true };
  }

  /** tasks 7.2 */
  app.post("/analysis-jobs", async (req, reply) => {
    const user = requireUser(req);

    const issues = await checkInitialAnalysisReadiness(prisma, user.id);
    if (issues.length > 0) {
      return reply.code(422).send({ error: "data_incomplete", issues });
    }
    const idempotencyKey = idempotencyKeyFrom(req);
    if (!idempotencyKey) return reply.code(400).send({ error: "valid Idempotency-Key header is required" });

    // 已开始执行的在途 job 直接复用；仍为 created 的 job 必须用稳定 BullMQ
    // jobId 重投一次，因为它可能是上次 Redis 故障留下的最小 outbox。
    const inflight = await prisma.analysisJob.findFirst({
      where: { userId: user.id, jobType: "initial_analysis", status: { notIn: ["completed", "completed_partial", "failed", "cancelled"] } },
    });
    if (inflight && inflight.status !== "created") {
      return reply.code(200).send({ jobId: inflight.id, status: inflight.status, reused: true });
    }

    if (!inflight) {
      const capacity = await checkGenerationCapacity(user.id);
      if (!capacity.ok) {
        return reply.code(429).send({
          error: "rate_limited",
          message: `每小时最多 ${capacity.cap} 次生成操作，请稍后再试`,
          retryAfterSeconds: capacity.retryAfterSeconds,
        });
      }
    }

    const job = inflight ?? await jobs.create({ userId: user.id, jobType: "initial_analysis", idempotencyKey });
    if (jobs.isTerminal(job.status)) {
      return reply.code(200).send({ jobId: job.id, status: job.status, reused: true });
    }
    const enqueued = await enqueueCreatedJob(
      QUEUE_NAMES.textAnalysis,
      "initial_analysis",
      job,
      { userId: user.id },
    );
    if (!enqueued.ok) {
      return reply.code(503).send({
        error: "queue_unavailable",
        message: "分析任务暂时无法投递，请重试",
        jobId: job.id,
        status: job.status,
        retryable: true,
      });
    }

    return reply.code(202).send({
      jobId: job.id,
      status: job.status,
      reused: Boolean(inflight),
      requeued: Boolean(inflight),
    });
  });

  /**
   * 用户显式要求“换一批”。普通重复 POST /analysis-jobs 仍复用首次推荐；
   * 只有这个独立入口会绕过 S3 的推荐事实缓存。
   */
  app.post("/plans/:planId/recommendations/refresh", async (req, reply) => {
    const user = requireUser(req);
    const idempotencyKey = idempotencyKeyFrom(req);
    if (!idempotencyKey) return reply.code(400).send({ error: "valid Idempotency-Key header is required" });
    const { planId } = req.params as { planId: string };
    const plan = await prisma.appearancePlan.findFirst({
      where: { id: planId, userId: user.id, status: "active" },
    });
    if (!plan) return reply.code(404).send({ error: "方案不存在" });

    const issues = await checkInitialAnalysisReadiness(prisma, user.id);
    if (issues.length > 0) {
      return reply.code(422).send({ error: "data_incomplete", issues });
    }
    const capacity = await checkGenerationCapacity(user.id);
    if (!capacity.ok) {
      return reply.code(429).send({
        error: "rate_limited",
        message: `每小时最多 ${capacity.cap} 次生成操作，请稍后再试`,
        retryAfterSeconds: capacity.retryAfterSeconds,
      });
    }

    const job = await jobs.create({
      userId: user.id,
      jobType: "initial_analysis",
      planId,
      idempotencyKey,
    });
    if (jobs.isTerminal(job.status)) {
      return reply.code(200).send({ jobId: job.id, status: job.status, reused: true, refreshed: true });
    }
    const enqueued = await enqueueCreatedJob(
      QUEUE_NAMES.textAnalysis,
      "initial_analysis",
      job,
      {
        userId: user.id,
        planId,
        forceRecommendationRefresh: true,
      },
    );
    if (!enqueued.ok) {
      return reply.code(503).send({
        error: "queue_unavailable",
        message: "换一批任务暂时无法投递，请重试",
        jobId: job.id,
        status: job.status,
        retryable: true,
      });
    }
    return reply.code(202).send({
      jobId: job.id,
      status: job.status,
      refreshed: true,
    });
  });

  /**
   * tasks 7.3：轮询。**部分结果随时可读**（决策 12）——
   * 文字推荐在 S3 完成时就返回，图片每出一张追加一张，客户端不必等 job 终态。
   */
  app.get("/analysis-jobs/:id", async (req, reply) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };

    const job = await jobs.get(id);
    if (!job) return reply.code(404).send({ error: "job 不存在" });
    if (job.userId !== user.id) return reply.code(403).send({ error: "无权访问该 job" });

    const previewJob = job.jobType === "hairstyle_preview_generation" || job.jobType === "outfit_preview_generation";
    const rawPartial = (job.partialResult ?? null) as Record<string, unknown> | null;
    // Provider failures, calibration gaps and retry diagnostics are audit data.
    // A preview is optional, so exposing them would turn a normal text fallback
    // into a user-facing technical error.
    const { missing: _internalMissing, ...publicPartial } = rawPartial ?? {};
    return reply.send({
      jobId: job.id,
      jobType: job.jobType,
      status: job.status,
      terminal: jobs.isTerminal(job.status),
      // initial_analysis 是方案的创建点，客户端只能从这里知道自己的 planId，
      // 后续 select-style / outfit-previews / materialize 全要用它。
      planId: job.planId ?? null,
      // 即使还在跑，已完成的部分也直接给出去
      partialResult: previewJob ? publicPartial : job.partialResult ?? null,
      errorReason: previewJob ? null : job.errorReason,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
      // 把该 job_type 的完整状态序列一起返回，客户端可据此算进度百分比
      expectedFlow: jobs.allowedFlowFor(job.jobType),
    });
  });

  /**
   * Feature-flagged second waiting point. This stays a worker job so the
   * multi-modal calls are never performed in the API process.
   */
  app.post("/plans/:planId/hairstyle-recommendations", async (req, reply) => {
    const user = requireUser(req);
    if (!env.server.dualSourceRecommendationEnabled) {
      return reply.code(409).send({ error: "dual_source_recommendation_disabled" });
    }
    const idempotencyKey = idempotencyKeyFrom(req);
    if (!idempotencyKey) return reply.code(400).send({ error: "valid Idempotency-Key header is required" });
    const { planId } = req.params as { planId: string };
    const plan = await prisma.appearancePlan.findFirst({ where: { id: planId, userId: user.id, status: "active" } });
    if (!plan) return reply.code(404).send({ error: "方案不存在" });
    if (!plan.selectedStyle) return reply.code(422).send({ error: "style_not_selected", message: "请先选定风格方向" });
    const capacity = await checkGenerationCapacity(user.id);
    if (!capacity.ok) return reply.code(429).send({ error: "rate_limited", retryAfterSeconds: capacity.retryAfterSeconds });
    const job = await jobs.create({ userId: user.id, planId, jobType: "hairstyle_recommendation", idempotencyKey });
    if (jobs.isTerminal(job.status)) return reply.send({ jobId: job.id, status: job.status, reused: true });
    const enqueued = await enqueueCreatedJob(
      QUEUE_NAMES.textAnalysis,
      "hairstyle_recommendation",
      job,
      { userId: user.id, planId },
    );
    if (!enqueued.ok) return reply.code(503).send({ error: "queue_unavailable", jobId: job.id, retryable: true });
    return reply.code(202).send({ jobId: job.id, status: job.status });
  });

  /** Optional visual comparison after the user has chosen a style. Text candidates stay usable without it. */
  app.post("/plans/:planId/hairstyle-previews", async (req, reply) => {
    const user = requireUser(req);
    if (!env.server.dualSourceRecommendationEnabled) {
      return reply.code(409).send({ error: "dual_source_recommendation_disabled" });
    }
    const idempotencyKey = idempotencyKeyFrom(req);
    if (!idempotencyKey) return reply.code(400).send({ error: "valid Idempotency-Key header is required" });
    const { planId } = req.params as { planId: string };
    const plan = await prisma.appearancePlan.findFirst({ where: { id: planId, userId: user.id, status: "active" } });
    if (!plan) return reply.code(404).send({ error: "方案不存在" });
    if (!plan.selectedStyle) return reply.code(422).send({ error: "style_not_selected", message: "请先选定风格方向" });
    const set = await prisma.recommendationSet.findFirst({ where: { planId, kind: "hairstyle", status: "ready" } });
    if (!set) return reply.code(422).send({ error: "hairstyle_recommendation_not_ready" });
    const capacity = await checkGenerationCapacity(user.id);
    if (!capacity.ok) return reply.code(429).send({ error: "rate_limited", retryAfterSeconds: capacity.retryAfterSeconds });
    const job = await jobs.create({ userId: user.id, planId, jobType: "hairstyle_preview_generation", idempotencyKey });
    if (jobs.isTerminal(job.status)) return reply.send({ jobId: job.id, status: job.status, reused: true });
    const enqueued = await enqueueCreatedJob(
      QUEUE_NAMES.imageGeneration,
      "hairstyle_preview_generation",
      job,
      { userId: user.id, planId },
    );
    if (!enqueued.ok) return reply.code(503).send({ error: "queue_unavailable", jobId: job.id, retryable: true });
    return reply.code(202).send({ jobId: job.id, status: job.status });
  });

  /** Third waiting point: system wardrobe recommendation needs both selections. */
  app.post("/plans/:planId/wardrobe-recommendations", async (req, reply) => {
    const user = requireUser(req);
    if (!env.server.dualSourceRecommendationEnabled) {
      return reply.code(409).send({ error: "dual_source_recommendation_disabled" });
    }
    const idempotencyKey = idempotencyKeyFrom(req);
    if (!idempotencyKey) return reply.code(400).send({ error: "valid Idempotency-Key header is required" });
    const { planId } = req.params as { planId: string };
    const plan = await prisma.appearancePlan.findFirst({ where: { id: planId, userId: user.id, status: "active" } });
    if (!plan) return reply.code(404).send({ error: "方案不存在" });
    if (!plan.selectedStyle) return reply.code(422).send({ error: "style_not_selected", message: "请先选定风格方向" });
    if (!plan.selectedHairstyleId) return reply.code(422).send({ error: "hairstyle_not_selected", message: "请先选定发型方向" });
    const capacity = await checkGenerationCapacity(user.id);
    if (!capacity.ok) return reply.code(429).send({ error: "rate_limited", retryAfterSeconds: capacity.retryAfterSeconds });
    const job = await jobs.create({ userId: user.id, planId, jobType: "wardrobe_recommendation", idempotencyKey });
    if (jobs.isTerminal(job.status)) return reply.send({ jobId: job.id, status: job.status, reused: true });
    const enqueued = await enqueueCreatedJob(
      QUEUE_NAMES.textAnalysis,
      "wardrobe_recommendation",
      job,
      { userId: user.id, planId },
    );
    if (!enqueued.ok) return reply.code(503).send({ error: "queue_unavailable", jobId: job.id, retryable: true });
    return reply.code(202).send({ jobId: job.id, status: job.status });
  });

  /** tasks 7.4：选定发型后触发穿搭预览 */
  app.post("/plans/:planId/outfit-previews", async (req, reply) => {
    const user = requireUser(req);
    const idempotencyKey = idempotencyKeyFrom(req);
    if (!idempotencyKey) return reply.code(400).send({ error: "valid Idempotency-Key header is required" });
    const { planId } = req.params as { planId: string };

    const plan = await prisma.appearancePlan.findFirst({ where: { id: planId, userId: user.id } });
    if (!plan) return reply.code(404).send({ error: "方案不存在" });
    if (!plan.selectedStyle) {
      return reply.code(422).send({ error: "style_not_selected", message: "请先选定风格方向" });
    }
    if (!plan.selectedHairstyleId) {
      // 决策 3：两步约束选择——穿搭候选集由已选发型过滤，没选发型就无从生成
      return reply.code(422).send({ error: "hairstyle_not_selected", message: "请先选定发型方向，穿搭候选会依据它筛选" });
    }
    if (env.server.dualSourceRecommendationEnabled) {
      if (plan.selectedOutfitId) {
        return reply.code(422).send({ error: "outfit_already_selected", message: "已选定穿搭，请直接生成方案或使用重新生成" });
      }
      const set = await prisma.recommendationSet.findFirst({ where: { planId, kind: "outfit", status: "ready" } });
      if (!set) return reply.code(422).send({ error: "outfit_recommendation_not_ready" });
    }

    const capacity = await checkGenerationCapacity(user.id);
    if (!capacity.ok) {
      return reply.code(429).send({
        error: "rate_limited",
        message: `每小时最多 ${capacity.cap} 次生成操作，请稍后再试`,
        retryAfterSeconds: capacity.retryAfterSeconds,
      });
    }

    const job = await jobs.create({ userId: user.id, jobType: "outfit_preview_generation", planId, idempotencyKey });
    if (jobs.isTerminal(job.status)) {
      return reply.code(200).send({ jobId: job.id, status: job.status, reused: true });
    }
    const enqueued = await enqueueCreatedJob(
      QUEUE_NAMES.imageGeneration,
      "outfit_preview_generation",
      job,
      { userId: user.id, planId },
    );
    if (!enqueued.ok) {
      return reply.code(503).send({
        error: "queue_unavailable",
        message: "穿搭预览任务暂时无法投递，请重试",
        jobId: job.id,
        status: job.status,
        retryable: true,
      });
    }
    return reply.code(202).send({ jobId: job.id, status: job.status });
  });

  /** tasks 7.5：选定穿搭后落地方案 */
  app.post("/plans/:planId/materialize", async (req, reply) => {
    const user = requireUser(req);
    const idempotencyKey = idempotencyKeyFrom(req);
    if (!idempotencyKey) return reply.code(400).send({ error: "valid Idempotency-Key header is required" });
    const { planId } = req.params as { planId: string };

    const plan = await prisma.appearancePlan.findFirst({ where: { id: planId, userId: user.id } });
    if (!plan) return reply.code(404).send({ error: "方案不存在" });
    if (!plan.selectedHairstyleId) {
      return reply.code(422).send({ error: "hairstyle_not_selected", message: "请先选定发型方向" });
    }
    if (!plan.selectedOutfitId) {
      return reply.code(422).send({ error: "outfit_not_selected", message: "请先选定穿搭方向" });
    }

    const job = await jobs.create({ userId: user.id, jobType: "plan_materialization", planId, idempotencyKey });
    if (jobs.isTerminal(job.status)) {
      return reply.code(200).send({ jobId: job.id, status: job.status, reused: true });
    }
    const enqueued = await enqueueCreatedJob(
      QUEUE_NAMES.textAnalysis,
      "plan_materialization",
      job,
      { userId: user.id, planId },
    );
    if (!enqueued.ok) {
      return reply.code(503).send({
        error: "queue_unavailable",
        message: "方案生成任务暂时无法投递，请重试",
        jobId: job.id,
        status: job.status,
        retryable: true,
      });
    }
    return reply.code(202).send({ jobId: job.id, status: job.status });
  });

  /**
   * tasks 7.7：用户主动重新生成目标图。
   * MVP1 不设计费 gate 但**正确记账**（决策 15）——支付上线时开关一打即生效，
   * 且这批数据用于校准定价。另有独立于计费的容量限流（决策 15）。
   */
  app.post("/plans/:planId/target-images/regenerate", async (req, reply) => {
    const user = requireUser(req);
    const idempotencyKey = idempotencyKeyFrom(req);
    if (!idempotencyKey) return reply.code(400).send({ error: "valid Idempotency-Key header is required" });
    const { planId } = req.params as { planId: string };

    const plan = await prisma.appearancePlan.findFirst({ where: { id: planId, userId: user.id } });
    if (!plan) return reply.code(404).send({ error: "方案不存在" });

    const capacity = await checkGenerationCapacity(user.id);
    if (!capacity.ok) {
      return reply.code(429).send({
        error: "rate_limited",
        message: `每小时最多 ${capacity.cap} 次生成操作，请稍后再试`,
        retryAfterSeconds: capacity.retryAfterSeconds,
      });
    }

    const stage = await prisma.stage.findFirst({
      where: { planId, status: "active", stageIndex: { gt: 0 } },
      orderBy: { stageIndex: "desc" },
    });
    if (!stage) {
      return reply.code(422).send({
        error: "target_stage_unavailable",
        message: "当前没有可重新生成目标图的已激活阶段",
      });
    }

    const job = await jobs.create({ userId: user.id, jobType: "user_regeneration", planId, idempotencyKey });
    if (jobs.isTerminal(job.status)) {
      return reply.code(200).send({ jobId: job.id, status: job.status, reused: true });
    }
    const enqueued = await enqueueCreatedJob(
      QUEUE_NAMES.imageGeneration,
      "user_regeneration",
      job,
      { userId: user.id, planId, stageId: stage.id },
    );
    if (!enqueued.ok) {
      return reply.code(503).send({
        error: "queue_unavailable",
        message: "目标图生成任务暂时无法投递，请重试",
        jobId: job.id,
        status: job.status,
        retryable: true,
      });
    }
    return reply.code(202).send({ jobId: job.id, status: job.status });
  });

  /** tasks 7.8：进度照片校准账本 */
  app.post("/plans/:planId/recheck", async (req, reply) => {
    const user = requireUser(req);
    const idempotencyKey = idempotencyKeyFrom(req);
    if (!idempotencyKey) return reply.code(400).send({ error: "valid Idempotency-Key header is required" });
    const { planId } = req.params as { planId: string };
    const { progressPhotoStorageKey } = (req.body ?? {}) as { progressPhotoStorageKey?: string };

    const plan = await prisma.appearancePlan.findFirst({ where: { id: planId, userId: user.id } });
    if (!plan) return reply.code(404).send({ error: "方案不存在" });
    if (!progressPhotoStorageKey) {
      return reply.code(400).send({ error: "缺少 progressPhotoStorageKey" });
    }
    const progressPhoto = await prisma.userPhoto.findFirst({
      where: {
        userId: user.id,
        storageKey: progressPhotoStorageKey,
        photoType: "progress",
        deletionStatus: "active",
        ...photoModerationWhere(),
      },
      select: { id: true },
    });
    if (!progressPhoto) {
      return reply.code(422).send({
        error: "invalid_progress_photo",
        message: "指定的进度照片不存在、未通过审核或不属于当前用户",
      });
    }

    const job = await jobs.create({ userId: user.id, jobType: "progress_recheck", planId, idempotencyKey });
    if (jobs.isTerminal(job.status)) {
      return reply.code(200).send({ jobId: job.id, status: job.status, reused: true });
    }
    const enqueued = await enqueueCreatedJob(
      QUEUE_NAMES.textAnalysis,
      "progress_recheck",
      job,
      { userId: user.id, planId, progressPhotoStorageKey },
    );
    if (!enqueued.ok) {
      return reply.code(503).send({
        error: "queue_unavailable",
        message: "进度复检任务暂时无法投递，请重试",
        jobId: job.id,
        status: job.status,
        retryable: true,
      });
    }
    return reply.code(202).send({ jobId: job.id, status: job.status });
  });
}
