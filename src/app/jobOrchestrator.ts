import type { AppContainer } from "./container.js";
import { photoModerationWhere } from "../lib/photoModerationGate.js";
import { env } from "../config/env.js";
import type { PrismaClient } from "../generated/prisma/client.js";
import { createAnalysisJobRepository } from "../repositories/analysisJobRepository.js";
import { createTargetImageService } from "../services/targetImageService.js";
import { createPlanRevisionService } from "../services/planRevisionService.js";
import { moderateInputStep } from "../steps/moderateInput.js";
import { analyzeVisionStep } from "../steps/analyzeVision.js";
import { recommendStep } from "../steps/recommend.js";
import { createRecommendationApplication } from "../services/recommendationApplication.js";
import { renderPreviewsStep, renderOutfitPreviewsStep } from "../steps/renderPreviews.js";
import { materializePlanStep, type MaterializeTaskSpec } from "../steps/materializePlan.js";
import { runWithSingleRetry, type StepContext, type StepDeps } from "../steps/types.js";
import { isCatalogDomain, isStyleDomain } from "../features/appearance-agent/data/domains.js";
import { deriveTaskDimensions } from "../features/appearance-agent/data/taskDimensions.js";
import { buildSelectedStyleTaskSpecs } from "../services/selectedStyleTaskService.js";
import { verifyProgressStep } from "../steps/verifyProgress.js";
import { DEFAULT_COMPATIBILITY_THRESHOLD } from "../features/appearance-agent/data/styleProfile.js";
import { createPhotoAccessService } from "../services/photoAccessService.js";

/**
 * jobType → step 管道的编排层。
 *
 * 为什么这层必须存在，以及它此前为何缺失：step（S1-S5）、路由、状态机三者都实现了，
 * 但没有任何东西把它们串起来——`worker.ts` 的 processor 一直是占位实现。所有验证
 * 脚本都**直接调用 step 函数**，于是测试全绿而 HTTP 全链路根本跑不通：
 * `POST /analysis-jobs` 返回 202、任务入队、worker 消费，然后 job 永远停在 `created`。
 *
 * 这层只做三件事，刻意不做第四件：
 *   1. 从库里**读齐** step 需要的输入（step 是纯函数形态，不自己查全局状态）
 *   2. 按 job_type 推进状态机，并逐步写回 `partialResult`（决策 12 的渐进式推送）
 *   3. 把失败收敛成 job 状态，而不是让异常穿透到 BullMQ 变成无限重试
 * 不做的是业务判断——发型怎么选、任务怎么落阶段，全在 step 里，这里不重复实现。
 */

export type JobPayload = {
  jobId: string;
  userId: string;
  planId?: string;
  stageId?: string;
  /** progress_recheck 用：调用方已完成归属校验的进度照对象键 */
  progressPhotoStorageKey?: string;
  /** progress_recheck 用：视觉分析认为实际未发生的变化描述 */
  unverifiedDescriptions?: string[];
  imageType?: "face_hair" | "full_body_outfit";
  /** 内部编排用；HTTP/worker payload 不应由客户端直接指定。 */
  generationTrigger?: "stage_unlock" | "user_regeneration" | "progress_recheck";
  /** 只有独立“换一批”入口可设置，普通重复分析必须复用首次推荐。 */
  forceRecommendationRefresh?: boolean;
};

export type OrchestratorResult = { status: string; detail?: Record<string, unknown> };

export function createJobOrchestrator(container: AppContainer) {
  const prisma: PrismaClient = container.prisma;
  const jobs = createAnalysisJobRepository(prisma);
  const targetImages = createTargetImageService(prisma, container.providers);
  const planRevision = createPlanRevisionService(prisma);
  const photoAccess = createPhotoAccessService(prisma);
  const deps: StepDeps = { prisma, providers: container.providers };

  /**
   * 状态跃迁失败**不中断流程**，只记录。
   * 状态机拒绝回退是对的（重跑该新建 job），但那不该让一个已经在跑的 job 崩掉——
   * 图片可能已经生成并计费了，此时中断等于白烧钱还不留结果。
   */
  async function step(jobId: string, next: Parameters<typeof jobs.transition>[1]): Promise<void> {
    const r = await jobs.transition(jobId, next);
    if (!r.ok) console.warn(`[orchestrator] job ${jobId} 跃迁到 ${next} 被拒: ${r.reason}`);
  }

  /**
   * 审核门槛统一走 `photoModerationWhere()`（见 lib/photoModerationGate.ts）。
   * 此前这个判定硬编码在 6 处，改一处漏一处，表现为「路由放行、某个 step 说找不到照片」。
   */

  async function loadPhotos(userId: string) {
    const front = await prisma.userPhoto.findFirst({
      where: {
        userId,
        photoType: "front",
        deletionStatus: "active",
        ...photoModerationWhere(),
      },
      orderBy: { uploadedAt: "desc" },
    });
    const fullBody = await prisma.userPhoto.findFirst({
      where: {
        userId,
        photoType: "full_body",
        deletionStatus: "active",
        ...photoModerationWhere(),
      },
      orderBy: { uploadedAt: "desc" },
    });
    return { front, fullBody };
  }

  /**
   * 拿到本用户的活跃方案；没有就创建。
   *
   * 方案在这里创建而不是在 HTTP 路由里：`generationSeed` 必须**建方案时一次定死**
   * 并全阶段复用（决策 4——实测 seed=-1 会让四阶段图像看起来像四个不同的人），
   * 而 seed 只有在确定要开始生成时才有意义。此前生产代码从未创建过方案，
   * `appearancePlan.create` 只出现在测试脚本里。
   */
  async function ensurePlan(userId: string) {
    const existing = await prisma.appearancePlan.findFirst({
      where: { userId, status: "active" },
      orderBy: { createdAt: "desc" },
    });
    if (existing) return existing;

    const profile = await prisma.appearanceProfile.findUnique({ where: { userId } });
    if (!profile?.track) {
      // 不默认成 short_term：赛道决定阶段窗口与推荐口径，猜错等于给用户一份错方案。
      // 路由侧的完整性校验本应挡住这种情况，走到这里说明流程被绕过了。
      throw new Error("用户未完成 basic 问卷（缺 track），无法创建方案");
    }

    return prisma.appearancePlan.create({
      data: {
        userId,
        track: profile.track,
        // 决策 4：per-user 固定 seed，全阶段复用以保证四张图是同一个人的递进
        generationSeed: Math.floor(Math.random() * 2_147_483_647),
        // 四个阶段必须**建方案时一并创建**：S5 落地任务时要求四条 Stage 已存在
        // （`materializePlanStep` 明确校验 `stages.length !== 4` 并失败）。
        // 只建方案不建阶段，S5 会以「方案应有 4 个阶段，实际 0 个」失败——实测踩过。
        // windowLabel 先留空，由 S5 按 STAGE_WINDOWS 统一写入，避免两处各写一份文案。
        stages: {
          create: [0, 1, 2, 3].map((i) => ({
            stageIndex: i,
            windowLabel: "",
            // 阶段 0 直接 active：它的任务是「当天 10-30 分钟」级别的，
            // 没有前置依赖，锁着反而让用户第一步无事可做
            status: i === 0 ? ("active" as const) : ("locked" as const),
            unlockRule: { require_all_core_tasks: true },
          })),
        },
      },
    });
  }

  const handlers = {
    /**
     * S1 → S2 → 建方案 → S3 → S4。
     * 每一步完成即写回 partialResult：文字推荐在 S3 结束时就可读，
     * 不必等图片（决策 12——图片是并发=1 的稀缺资源，等它等于让用户干等 1 分钟）。
     */
    async initial_analysis(p: JobPayload): Promise<OrchestratorResult> {
      const ctx: StepContext = { jobId: p.jobId, userId: p.userId };
      const { front, fullBody } = await loadPhotos(p.userId);
      if (!front) {
        await jobs.fail(p.jobId, "缺少正面照");
        return { status: "failed", detail: { reason: "no_front_photo" } };
      }
      const profile = await prisma.appearanceProfile.findUnique({ where: { userId: p.userId } });

      // ── S1 输入审核 ──
      await step(p.jobId, "input_moderating");
      const s1 = await runWithSingleRetry(
        moderateInputStep,
        {
          // 意向文本从库里读——它在同步的 hair-intent 请求里过审并落库（决策 3）
          texts: profile?.stylePreferenceText ? [profile.stylePreferenceText] : [],
          photoStorageKeys: [front.storageKey, ...(fullBody ? [fullBody.storageKey] : [])],
        },
        ctx,
        deps,
      );
      if (s1.status === "failed") {
        await jobs.fail(p.jobId, `S1 失败: ${s1.error}`);
        return { status: "failed" };
      }
      if (s1.data.hasBlocked) {
        // 红线命中就终止，不进后续步骤——这是硬边界，不是可降级项
        await jobs.fail(p.jobId, "输入包含超出服务范围的内容");
        return { status: "failed", detail: { reason: "blocked" } };
      }
      await jobs.mergePartialResult(p.jobId, { moderation: { photoVerdicts: s1.data.photoVerdicts } });

      // ── S2 视觉分析 ──
      await step(p.jobId, "analyzing");
      const s2 = await runWithSingleRetry(
        analyzeVisionStep,
        { frontPhotoStorageKey: front.storageKey, fullBodyPhotoStorageKey: fullBody?.storageKey },
        ctx,
        deps,
      );
      if (s2.status === "failed") {
        await jobs.fail(p.jobId, `S2 失败: ${s2.error}`);
        return { status: "failed" };
      }
      await jobs.mergePartialResult(p.jobId, {
        vision: {
          geometry: s2.data.geometry,
          hairSignals: s2.data.hairSignals,
          structuredSemantic: s2.data.structuredSemantic,
          hasFullBody: s2.data.hasFullBody,
        },
      });

      // ── 建方案（S3 要读 femaleAppealWeight，所以必须先于 S3）──
      const plan = await ensurePlan(p.userId);
      await prisma.analysisJob.update({ where: { id: p.jobId }, data: { planId: plan.id } });
      const planCtx: StepContext = { ...ctx, planId: plan.id };

      // ── S3 推荐 ──
      await step(p.jobId, "recommending");
      const s3 = await runWithSingleRetry(
        recommendStep,
        {
          vision: s2.data,
          // 照片授权交给应用模块：签发与访问记录在那里统一处理
          frontPhotoStorageKey: front.storageKey,
          userPreferenceText: profile?.stylePreferenceText ?? undefined,
          userPreferenceStyleTag: profile?.stylePreferenceStyleTag ?? null,
          changeWillingness: profile?.changeWillingness ?? null,
        },
        planCtx,
        deps,
      );
      if (s3.status === "failed") {
        await jobs.fail(p.jobId, `S3 失败: ${s3.error}`);
        return { status: "failed" };
      }
      const recommendation = {
        setId: s3.data.setId,
        candidates: s3.data.candidates,
        capabilityStatus: s3.data.capabilityStatus,
        reused: s3.data.reused,
      };

      if (s3.data.candidates.length === 0) {
        await jobs.mergePartialResult(p.jobId, { planId: plan.id, recommendation });
        await jobs.complete(p.jobId, {
          missing: [{
            item: "发型候选",
            reason: s3.data.inProgress
              ? "另一个请求正在生成候选，请稍后重试"
              : "provider 未产出通过校验的候选，未放宽约束",
          }],
        });
        return { status: "completed_partial", detail: { candidates: 0 } };
      }

      // 文字候选先落地，客户端此刻已有内容可读；图片随后逐张追加（决策 12）
      await jobs.mergePartialResult(p.jobId, { planId: plan.id, recommendation });

      // ── S4 发型预览（串行，顺序=匹配度降序）──
      await step(p.jobId, "rendering");
      const s4 = await runWithSingleRetry(
        renderPreviewsStep,
        {
          baselinePhotoStorageKey: front.storageKey,
          // renderInstruction 已含身份保持后缀，这里不再拼指令
          candidates: s3.data.candidates.map((c) => ({
            candidateId: c.candidateId,
            nameZh: c.nameZh,
            renderInstruction: c.renderInstruction,
            modelRationale: c.modelRationale,
          })),
          kind: "hairstyle",
        },
        planCtx,
        deps,
      );
      if (s4.status === "failed") {
        // 图片没出来但文字推荐已经推给用户了，收成部分成功而非 failed——
        // 报 failed 会让客户端把已读到的推荐也丢掉
        await jobs.complete(p.jobId, {
          missing: [
            { item: "发型效果图", reason: s4.error },
          ],
        });
        return { status: "completed_partial", detail: { reason: s4.error } };
      }
      const missing = [
        ...(s3.status === "completed_partial" ? s3.missing : []),
        ...(s4.status === "completed_partial" ? s4.missing : []),
      ];
      await jobs.complete(p.jobId, { missing: missing.length > 0 ? missing : undefined });
      return {
        status: missing.length > 0 ? "completed_partial" : "completed",
        detail: { previews: s4.data.previews.length },
      };
    },

    /** S4′ 穿搭预览。无全身照时降级为文字+示意图（决策 11），不造全身照。 */
    async outfit_preview_generation(p: JobPayload): Promise<OrchestratorResult> {
      if (!p.planId) {
        await jobs.fail(p.jobId, "缺少 planId");
        return { status: "failed" };
      }
      const ctx: StepContext = { jobId: p.jobId, userId: p.userId, planId: p.planId };
      const { fullBody } = await loadPhotos(p.userId);

      const plan = await prisma.appearancePlan.findUnique({ where: { id: p.planId } });
      // 决策 3：穿搭候选受已选发型约束。发型未选时路由已 422，这里是防御性检查
      if (!plan?.selectedHairstyleId) {
        await jobs.fail(p.jobId, "尚未选定发型，无法筛选穿搭候选");
        return { status: "failed" };
      }

      const hairstyle = await prisma.styleProfileEntry.findUnique({ where: { id: plan.selectedHairstyleId } });
      const outfits = await prisma.styleProfileEntry.findMany({
        where: { kind: "outfit_combo", isRecommended: true },
      });
      const coordinationAvailable = Boolean(
        hairstyle &&
          hairstyle.formality !== null &&
          hairstyle.maturity !== null &&
          hairstyle.boldness !== null &&
          hairstyle.upkeep !== null,
      );
      // 穿搭候选改由应用模块产出：不再从 StyleProfileEntry 按双审美评分筛选
      // （那份数据为空，会导致零候选并卡住 /materialize）
      const profileForOutfit = await prisma.appearanceProfile.findUnique({ where: { userId: p.userId } });
      const eventForOutfit = await prisma.event.findUnique({ where: { userId: p.userId } });
      const outfitApp = createRecommendationApplication({
        prisma,
        hairstyleProvider: container.providers.hairstyleRecommendation,
        outfitProvider: container.providers.outfitRecommendation,
      });
      const outfitView = await outfitApp.recommendOutfits({
        userId: p.userId,
        planId: p.planId,
        requestedCount: 3,
        selectedHairstyleCandidateId: plan.selectedHairstyleId!,
        body: {
          heightCm: profileForOutfit?.heightCm ?? null,
          weightKg: profileForOutfit?.weightKg ?? null,
          bodyFatPercent: profileForOutfit?.bodyFatPercent ?? null,
          shoulderWidthCm: profileForOutfit?.shoulderWidthCm ?? null,
          chestCm: profileForOutfit?.chestCm ?? null,
          waistCm: profileForOutfit?.waistCm ?? null,
          thighCm: profileForOutfit?.thighCm ?? null,
          exercisesRegularly: profileForOutfit?.exercisesRegularly ?? null,
        },
        scene: {
          track: plan.track,
          eventType: eventForOutfit?.eventType ?? (plan.track === "long_term" ? "日常" : null),
          eventDate: eventForOutfit?.eventDate ?? null,
        },
        budgetTier: profileForOutfit?.budgetTier ?? null,
        // 有全身照才传，纯文字路径不签发照片地址
        fullBodyPhotoStorageKey: fullBody?.storageKey,
      });

      if (outfitView.candidates.length === 0) {
        await jobs.complete(p.jobId, {
          missing: [{ item: "穿搭候选", reason: "provider 未产出通过校验的候选" }],
        });
        return { status: "completed_partial", detail: { candidates: 0 } };
      }

      await step(p.jobId, "rendering");
      const s4b = await runWithSingleRetry(
        renderOutfitPreviewsStep,
        {
          fullBodyPhotoStorageKey: fullBody?.storageKey,
          candidates: outfitView.candidates.map((c) => ({
            candidateId: c.candidateId,
            nameZh: c.nameZh,
            renderInstruction: c.renderInstruction,
            modelRationale: c.modelRationale,
          })),
        },
        ctx,
        deps,
      );
      if (s4b.status === "failed") {
        await jobs.fail(p.jobId, `S4′ 失败: ${s4b.error}`);
        return { status: "failed" };
      }
      await jobs.mergePartialResult(p.jobId, {
        outfit: {
          mode: s4b.data.mode,
          previews: s4b.data.previews,
          degradedNotice: s4b.data.degradedNotice,
          coordination: coordinationAvailable
            ? { available: true, method: "catalog_style_vector_threshold" }
            : {
                available: false,
                reason: "选定发型来自 vision-LLM，没有可信风格向量；本次穿搭未做协调过滤",
              },
        },
      });
      await jobs.complete(p.jobId, { missing: s4b.status === "completed_partial" ? s4b.missing : undefined });
      return { status: s4b.status, detail: { mode: s4b.data.mode } };
    },

    /**
     * S5 落地方案。任务规格从 `CandidateTaskCatalog`（非风格领域）+ 已选风格组装。
     * 阶段落位读 `applicableStageRange`，与打分无关（决策 7）。
     */
    async plan_materialization(p: JobPayload): Promise<OrchestratorResult> {
      if (!p.planId) {
        await jobs.fail(p.jobId, "缺少 planId");
        return { status: "failed" };
      }
      const ctx: StepContext = { jobId: p.jobId, userId: p.userId, planId: p.planId };
      const profile = await prisma.appearanceProfile.findUnique({ where: { userId: p.userId } });
      const plan = await prisma.appearancePlan.findUnique({
        where: { id: p.planId },
        select: { selectedHairstyleId: true, selectedOutfitId: true },
      });
      if (!plan?.selectedHairstyleId || !plan.selectedOutfitId) {
        await jobs.fail(
          p.jobId,
          "方案物化前必须同时选定发型和穿搭",
        );
        return { status: "failed" };
      }
      // 选定项现在是 RecommendationCandidate，不再是 StyleProfileEntry。
      // 候选可能来自 Agent 而无目录引用，所以按候选 id 取。
      const [selectedHairstyle, selectedOutfit] = await Promise.all([
        prisma.recommendationCandidate.findUnique({
          where: { id: plan.selectedHairstyleId },
          include: { set: true },
        }),
        prisma.recommendationCandidate.findUnique({
          where: { id: plan.selectedOutfitId },
          include: { set: true },
        }),
      ]);
      let selectedStyleSpecs: MaterializeTaskSpec[];
      try {
        selectedStyleSpecs = buildSelectedStyleTaskSpecs({
          hairstyle: selectedHairstyle
            ? { kind: selectedHairstyle.set.kind, nameZh: selectedHairstyle.nameZh, description: selectedHairstyle.description }
            : null,
          outfit: selectedOutfit
            ? { kind: selectedOutfit.set.kind, nameZh: selectedOutfit.nameZh, description: selectedOutfit.description }
            : null,
        });
      } catch (error) {
        await jobs.fail(p.jobId, error instanceof Error ? error.message : String(error));
        return { status: "failed" };
      }
      const allSelected = profile?.domainSelections ?? [];
      // 只拿**目录驱动**的领域来过滤方法目录。发型/穿搭由 StyleProfileEntry 经
      // S3/S4 处理，不在目录里；混进来只会永远匹配不到（见 data/domains.ts）
      // Set<string> 而非 Set<CatalogDomain>：右侧比较的 c.domain 是库里的自由字符串，
      // 收窄成联合类型只会让比较处报错，收窄的价值在过滤那一步已经拿到了
      const catalogSelected = new Set<string>(allSelected.filter(isCatalogDomain));
      const styleSelected = allSelected.filter(isStyleDomain);

      const catalog = await prisma.candidateTaskCatalog.findMany({ where: { isRecommended: true } });
      const catalogSpecs: MaterializeTaskSpec[] = catalog
        // 用户没选的领域不进方案——选择本身是产品承诺的一部分，不能替他扩张
        .filter((c) => catalogSelected.size === 0 || catalogSelected.has(c.domain))
        .map((c) => ({
          domain: c.domain,
          title: c.methodName,
          applicableStageRange: c.applicableStageRange,
          evidenceBasis: c.evidenceBasis,
          changeDescription: c.description,
          estTime: c.estTime ?? undefined,
          estCost: c.estCostRange ?? undefined,
          rationale: c.riskNote ?? undefined,
          // 必须给 dimensions：缺省时任务直接判 optional，导致每阶段 coreCount=0，
          // 而「完成所有 core 才解锁」在 core=0 时空真 → 四阶段立刻全解锁，
          // 分阶段推进整体失效。实测踩过这个坑。
          dimensions: deriveTaskDimensions(c, profile?.domainAcceptance),
        }));
      const specs: MaterializeTaskSpec[] = [
        ...catalogSpecs,
        ...selectedStyleSpecs,
      ];

      await step(p.jobId, "materializing");
      const s5 = await runWithSingleRetry(materializePlanStep, { planId: p.planId, tasks: specs }, ctx, deps);
      if (s5.status === "failed") {
        await jobs.fail(p.jobId, `S5 失败: ${s5.error}`);
        return { status: "failed" };
      }
      await jobs.mergePartialResult(p.jobId, {
        materialization: s5.data,
        domains: { catalogDriven: [...catalogSelected], styleDriven: styleSelected },
      });

      // 零任务**不能report成 completed**：用户会看到一份空方案而我们显示"成功"。
      // 实测踩过——问卷词表与目录词表不重叠时正是这个结果。
      const missing = s5.status === "completed_partial" ? (s5.missing ?? []) : [];
      if (s5.data.totalTasks === 0) {
        missing.push({
          item: "阶段任务",
          reason: catalogSelected.size === 0
            ? `用户选择的领域（${allSelected.join("/") || "无"}）均非方法目录驱动，目录侧无任务可落`
            : `方法目录中没有匹配 ${[...catalogSelected].join("/")} 的可推荐条目`,
        });
      }
      await jobs.complete(p.jobId, { missing: missing.length > 0 ? missing : undefined });
      return { status: missing.length > 0 ? "completed_partial" : s5.status, detail: { totalTasks: s5.data.totalTasks } };
    },

    /** 阶段解锁后的目标图。失败不影响解锁——目标图是激励物不是门槛（决策：tasks 7.6）。 */
    async stage_unlock_generation(p: JobPayload): Promise<OrchestratorResult> {
      if (!p.planId || !p.stageId) {
        await jobs.fail(p.jobId, "缺少 planId 或 stageId");
        return { status: "failed" };
      }
      await step(p.jobId, "rendering");
      const r = await targetImages.generateForStage({
        jobId: p.jobId,
        planId: p.planId,
        stageId: p.stageId,
        imageType: p.imageType ?? "face_hair",
        trigger: p.generationTrigger ?? "stage_unlock",
      });
      await step(p.jobId, "quality_checking");
      if (!r.ok) {
        await jobs.mergePartialResult(p.jobId, { targetImage: { generated: false, reason: r.reason, stageStillUnlocked: true } });
        await jobs.complete(p.jobId, { missing: [{ item: "阶段目标图", reason: r.reason }] });
        return { status: "completed_partial", detail: { reason: r.reason } };
      }
      await jobs.mergePartialResult(p.jobId, { targetImage: { generated: true, targetImageId: r.targetImageId, readUrl: r.readUrl } });
      await jobs.complete(p.jobId);
      return { status: "completed" };
    },

    /** 用户主动重生成。与 stage_unlock 同一条生成路径，区别只在触发者与限流。 */
    async user_regeneration(p: JobPayload): Promise<OrchestratorResult> {
      return handlers.stage_unlock_generation({
        ...p,
        generationTrigger: "user_regeneration",
      });
    },

    /** 进度复核：用视觉判断校准自报账本（决策 13）。 */
    async progress_recheck(p: JobPayload): Promise<OrchestratorResult> {
      if (!p.planId || !p.progressPhotoStorageKey) {
        await jobs.fail(p.jobId, "缺少 planId 或 progressPhotoStorageKey");
        return { status: "failed" };
      }
      await step(p.jobId, "analyzing");
      const entries = await prisma.changeManifestEntry.findMany({
        where: { planId: p.planId, verificationStatus: "unverified" },
        select: { id: true, changeDescription: true },
      });
      if (entries.length === 0) {
        const plan = await prisma.appearancePlan.findUniqueOrThrow({ where: { id: p.planId } });
        const detail = { rolledBack: 0, verified: 0, uncertain: 0, planVersion: plan.planVersion };
        await jobs.mergePartialResult(p.jobId, { recheck: detail });
        await jobs.complete(p.jobId);
        return { status: "completed", detail };
      }

      const verification = await runWithSingleRetry(
        verifyProgressStep,
        {
          progressPhotoStorageKey: p.progressPhotoStorageKey,
          entries: entries.map((entry) => ({
            entryId: entry.id,
            changeDescription: entry.changeDescription,
          })),
        },
        { jobId: p.jobId, userId: p.userId, planId: p.planId },
        deps,
      );

      if (verification.status === "failed") {
        const reason = `逐项进度核验失败，账本保持未验证：${verification.error}`;
        await jobs.mergePartialResult(p.jobId, { recheck: { verified: 0, rolledBack: 0, uncertain: entries.length } });
        await jobs.complete(p.jobId, { missing: [{ item: "逐项进度核验", reason }] });
        return { status: "completed_partial", detail: { reason } };
      }

      const r = await planRevision.reconcileManifest({
        planId: p.planId,
        verificationEvidence: verification.data.verdicts,
      });
      const uncertain = verification.data.verdicts.filter((verdict) => verdict.status === "uncertain").length;
      await jobs.mergePartialResult(p.jobId, {
        recheck: {
          ...r,
          uncertain,
          provider: verification.data.provider,
          verdicts: verification.data.verdicts,
        },
      });

      const missing: { item: string; reason: string }[] = [];
      if (uncertain > 0) {
        missing.push({
          item: "逐项进度核验",
          reason: `${uncertain} 条变化无法从当前照片可靠判断，已保持未验证`,
        });
      }

      let regeneratedTarget: Record<string, unknown> = { attempted: false };
      if (r.rolledBack > 0) {
        const activeStage = await prisma.stage.findFirst({
          where: { planId: p.planId, status: "active", stageIndex: { gt: 0 } },
          orderBy: { stageIndex: "desc" },
        });
        if (activeStage) {
          const latestTarget = await prisma.targetImage.findFirst({
            where: { planId: p.planId, stageId: activeStage.id },
            orderBy: { createdAt: "desc" },
            select: { imageType: true },
          });
          const imageType =
            latestTarget?.imageType === "full_body_outfit"
              ? "full_body_outfit"
              : "face_hair";

          await step(p.jobId, "rendering");
          const target = await targetImages.generateForStage({
            jobId: p.jobId,
            planId: p.planId,
            stageId: activeStage.id,
            imageType,
            trigger: "progress_recheck",
          });
          await step(p.jobId, "quality_checking");
          regeneratedTarget = target.ok
            ? {
                attempted: true,
                generated: true,
                targetImageId: target.targetImageId,
                readUrl: target.readUrl,
              }
            : {
                attempted: true,
                generated: false,
                reason: target.reason,
                stageStillUnlocked: true,
              };
          if (!target.ok) {
            missing.push({ item: "校准后的目标图", reason: target.reason });
          }
        } else {
          regeneratedTarget = {
            attempted: false,
            reason: "当前处于阶段 0 或没有已激活的目标图阶段，无需重生成",
          };
        }
      }

      await jobs.mergePartialResult(p.jobId, {
        recheckTargetImage: regeneratedTarget,
      });
      await jobs.complete(p.jobId, { missing: missing.length > 0 ? missing : undefined });
      return {
        status: missing.length > 0 ? "completed_partial" : "completed",
        detail: { ...r, uncertain, targetImage: regeneratedTarget },
      };
    },
  };

  return {
    handlers,
    /**
     * 统一入口。异常在这里收敛成 job 的 failed 状态而**不重新抛出**：
     * 抛出会让 BullMQ 按重试策略反复执行整条管道，而管道里含真实计费的图片生成——
     * 一次代码 bug 就能变成重复扣费。job 状态已经记录了失败，可观察即够。
     */
    async run(jobType: keyof typeof handlers, payload: JobPayload): Promise<OrchestratorResult> {
      const handler = handlers[jobType];
      if (!handler) {
        await jobs.fail(payload.jobId, `未知 jobType: ${jobType}`);
        return { status: "failed" };
      }
      try {
        return await handler(payload);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[orchestrator] ${jobType} job ${payload.jobId} 异常:`, msg);
        await jobs.fail(payload.jobId, msg);
        return { status: "failed", detail: { error: msg } };
      }
    },
  };
}

export type JobOrchestrator = ReturnType<typeof createJobOrchestrator>;
