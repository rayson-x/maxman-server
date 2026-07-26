import type { FastifyInstance } from "fastify";
import { requireUser } from "../plugins/session.js";
import { createAnalysisJobRepository } from "../repositories/analysisJobRepository.js";
import { QUEUE_NAMES } from "../lib/queues.js";

/**
 * Job 触发与轮询（tasks 7.2-7.5, 7.7-7.8）。
 *
 * 三个 job 对应流程里两次同步用户选择切开的三段（design.md job_type 重定义）：
 *   POST /analysis-jobs                     → initial_analysis（S1-S4）
 *   POST /plans/:id/outfit-previews         → outfit_preview_generation（S4'，选定发型后）
 *   POST /plans/:id/materialize             → plan_materialization（S5，选定穿搭后）
 *
 * 前一份 spec 想用一个 `full_analysis` 一口气跑完，但流程中间有用户选择，
 * 物理上不可能连续执行。
 */

type CompletenessIssue = { field: string; message: string };

/** initial_analysis 的前置校验（tasks 7.2）。缺什么说清楚，不要只回一句"数据不完整" */
async function checkInitialAnalysisReadiness(
  prisma: FastifyInstance["container"]["prisma"],
  userId: string,
): Promise<CompletenessIssue[]> {
  const issues: CompletenessIssue[] = [];

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
  }

  return issues;
}

export async function registerAnalysisJobRoutes(app: FastifyInstance): Promise<void> {
  const { prisma, queues } = app.container;
  const jobs = createAnalysisJobRepository(prisma);

  /** tasks 7.2 */
  app.post("/analysis-jobs", async (req, reply) => {
    const user = requireUser(req);

    const issues = await checkInitialAnalysisReadiness(prisma, user.id);
    if (issues.length > 0) {
      return reply.code(422).send({ error: "data_incomplete", issues });
    }

    // 已有在途的同类型 job 就复用，不重复入队——重复触发会白烧图片钱
    const inflight = await prisma.analysisJob.findFirst({
      where: { userId: user.id, jobType: "initial_analysis", status: { notIn: ["completed", "completed_partial", "failed", "cancelled"] } },
    });
    if (inflight) {
      return reply.code(200).send({ jobId: inflight.id, status: inflight.status, reused: true });
    }

    const job = await jobs.create({ userId: user.id, jobType: "initial_analysis" });
    await queues.queues[QUEUE_NAMES.textAnalysis].add("initial_analysis", { jobId: job.id, userId: user.id });

    return reply.code(202).send({ jobId: job.id, status: job.status, reused: false });
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

    return reply.send({
      jobId: job.id,
      jobType: job.jobType,
      status: job.status,
      terminal: jobs.isTerminal(job.status),
      // 即使还在跑，已完成的部分也直接给出去
      partialResult: job.partialResult ?? null,
      errorReason: job.errorReason,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
      // 把该 job_type 的完整状态序列一起返回，客户端可据此算进度百分比
      expectedFlow: jobs.allowedFlowFor(job.jobType),
    });
  });

  /** tasks 7.4：选定发型后触发穿搭预览 */
  app.post("/plans/:planId/outfit-previews", async (req, reply) => {
    const user = requireUser(req);
    const { planId } = req.params as { planId: string };

    const plan = await prisma.appearancePlan.findFirst({ where: { id: planId, userId: user.id } });
    if (!plan) return reply.code(404).send({ error: "方案不存在" });
    if (!plan.selectedHairstyleId) {
      // 决策 3：两步约束选择——穿搭候选集由已选发型过滤，没选发型就无从生成
      return reply.code(422).send({ error: "hairstyle_not_selected", message: "请先选定发型方向，穿搭候选会依据它筛选" });
    }

    const job = await jobs.create({ userId: user.id, jobType: "outfit_preview_generation", planId });
    await queues.queues[QUEUE_NAMES.imageGeneration].add("outfit_preview_generation", { jobId: job.id, userId: user.id, planId });
    return reply.code(202).send({ jobId: job.id, status: job.status });
  });

  /** tasks 7.5：选定穿搭后落地方案 */
  app.post("/plans/:planId/materialize", async (req, reply) => {
    const user = requireUser(req);
    const { planId } = req.params as { planId: string };

    const plan = await prisma.appearancePlan.findFirst({ where: { id: planId, userId: user.id } });
    if (!plan) return reply.code(404).send({ error: "方案不存在" });
    if (!plan.selectedHairstyleId) {
      return reply.code(422).send({ error: "hairstyle_not_selected", message: "请先选定发型方向" });
    }

    const job = await jobs.create({ userId: user.id, jobType: "plan_materialization", planId });
    await queues.queues[QUEUE_NAMES.textAnalysis].add("plan_materialization", { jobId: job.id, userId: user.id, planId });
    return reply.code(202).send({ jobId: job.id, status: job.status });
  });

  /**
   * tasks 7.7：用户主动重新生成目标图。
   * MVP1 不设计费 gate 但**正确记账**（决策 15）——支付上线时开关一打即生效，
   * 且这批数据用于校准定价。另有独立于计费的容量限流（决策 15）。
   */
  app.post("/plans/:planId/target-images/regenerate", async (req, reply) => {
    const user = requireUser(req);
    const { planId } = req.params as { planId: string };

    const plan = await prisma.appearancePlan.findFirst({ where: { id: planId, userId: user.id } });
    if (!plan) return reply.code(404).send({ error: "方案不存在" });

    // 容量限流：并发=1 的全局队列，单用户连点会拖垮其他人的 onboarding。
    // 这与计费无关，支付上线后也保留。
    const oneHourAgo = new Date(Date.now() - 3600_000);
    const recentGenerations = await prisma.analysisJob.count({
      where: {
        userId: user.id,
        jobType: { in: ["user_regeneration", "outfit_preview_generation", "stage_unlock_generation"] },
        createdAt: { gte: oneHourAgo },
      },
    });
    const HOURLY_CAP = Number(process.env.GENERATION_HOURLY_CAP ?? "3");
    if (recentGenerations >= HOURLY_CAP) {
      return reply.code(429).send({
        error: "rate_limited",
        message: `每小时最多 ${HOURLY_CAP} 次生成操作，请稍后再试`,
        retryAfterSeconds: 600,
      });
    }

    const job = await jobs.create({ userId: user.id, jobType: "user_regeneration", planId });
    await queues.queues[QUEUE_NAMES.imageGeneration].add("user_regeneration", { jobId: job.id, userId: user.id, planId });
    return reply.code(202).send({ jobId: job.id, status: job.status });
  });

  /** tasks 7.8：进度照片校准账本 */
  app.post("/plans/:planId/recheck", async (req, reply) => {
    const user = requireUser(req);
    const { planId } = req.params as { planId: string };
    const { progressPhotoStorageKey } = (req.body ?? {}) as { progressPhotoStorageKey?: string };

    const plan = await prisma.appearancePlan.findFirst({ where: { id: planId, userId: user.id } });
    if (!plan) return reply.code(404).send({ error: "方案不存在" });
    if (!progressPhotoStorageKey) {
      return reply.code(400).send({ error: "缺少 progressPhotoStorageKey" });
    }

    const job = await jobs.create({ userId: user.id, jobType: "progress_recheck", planId });
    await queues.queues[QUEUE_NAMES.textAnalysis].add("progress_recheck", {
      jobId: job.id, userId: user.id, planId, progressPhotoStorageKey,
    });
    return reply.code(202).send({ jobId: job.id, status: job.status });
  });
}
