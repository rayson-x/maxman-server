import type { AppContainer } from "./container.js";
import type { PrismaClient } from "../generated/prisma/client.js";
import { createAnalysisJobRepository } from "../repositories/analysisJobRepository.js";
import { createTargetImageService } from "../services/targetImageService.js";
import { createPlanRevisionService } from "../services/planRevisionService.js";
import { moderateInputStep } from "../steps/moderateInput.js";
import { analyzeVisionStep } from "../steps/analyzeVision.js";
import { recommendStep, type ScoredCandidate } from "../steps/recommend.js";
import { renderPreviewsStep, renderOutfitPreviewsStep } from "../steps/renderPreviews.js";
import { materializePlanStep, type MaterializeTaskSpec } from "../steps/materializePlan.js";
import { runWithSingleRetry, type StepContext, type StepDeps } from "../steps/types.js";
import { isCatalogDomain, isStyleDomain } from "../features/appearance-agent/data/domains.js";
import { deriveTaskDimensions } from "../features/appearance-agent/data/taskDimensions.js";

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
  /** progress_recheck 用：视觉分析认为实际未发生的变化描述 */
  unverifiedDescriptions?: string[];
  imageType?: "face_hair" | "full_body_outfit";
};

export type OrchestratorResult = { status: string; detail?: Record<string, unknown> };

export function createJobOrchestrator(container: AppContainer) {
  const prisma: PrismaClient = container.prisma;
  const jobs = createAnalysisJobRepository(prisma);
  const targetImages = createTargetImageService(prisma, container.providers);
  const planRevision = createPlanRevisionService(prisma);
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

  async function loadPhotos(userId: string) {
    const front = await prisma.userPhoto.findFirst({
      where: { userId, photoType: "front", deletionStatus: "active" },
      orderBy: { uploadedAt: "desc" },
    });
    const fullBody = await prisma.userPhoto.findFirst({
      where: { userId, photoType: "full_body", deletionStatus: "active" },
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

  /** 把候选补上生成指令。指令用目录里的 nameZh/description，不让 LLM 现编。 */
  async function withChangeInstructions(
    candidates: ScoredCandidate[],
    kind: "hairstyle" | "outfit",
  ): Promise<(ScoredCandidate & { changeInstruction: string })[]> {
    const entries = await prisma.styleProfileEntry.findMany({
      where: { id: { in: candidates.map((c) => c.entryId) } },
    });
    const byId = new Map(entries.map((e) => [e.id, e]));
    return candidates.map((c) => {
      const e = byId.get(c.entryId);
      const desc = e?.description?.trim();
      return {
        ...c,
        changeInstruction: kind === "hairstyle"
          ? `把发型改成${c.nameZh}${desc ? `（${desc}）` : ""}`
          : `换成这套穿搭：${c.nameZh}${desc ? `（${desc}）` : ""}`,
      };
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
        vision: { geometry: s2.data.geometry, hairSignals: s2.data.hairSignals, hasFullBody: s2.data.hasFullBody },
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
          userPreferenceText: profile?.stylePreferenceText ?? undefined,
          userPreferenceStyleTag: profile?.stylePreferenceStyleTag ?? null,
        },
        planCtx,
        deps,
      );
      if (s3.status === "failed") {
        await jobs.fail(p.jobId, `S3 失败: ${s3.error}`);
        return { status: "failed" };
      }
      // 文字推荐先落地——客户端此刻已有内容可读
      await jobs.mergePartialResult(p.jobId, {
        planId: plan.id,
        recommendation: {
          hairConstraint: s3.data.hairConstraint,
          filterTrace: s3.data.filterTrace,
          candidates: s3.data.hairstyleCandidates,
          userPreferenceAssessment: s3.data.userPreferenceAssessment,
          dataReady: s3.data.dataReady,
        },
      });
      // ⚠ 刻意不在这里写「待生成数」：`renderPreviewsStep` 自己维护
      // `hairstylePreviewsPending` 并逐张递减。这里再写一个 `pendingPreviews`
      // 就是同一件事两个计数器，而这一个永远不会被递减——实测过一次，
      // 客户端会一直以为还有 3 张在路上。计数由真正推进它的那一方独占。

      if (s3.data.hairstyleCandidates.length === 0) {
        // 风格数据未就绪时如实收尾，不假装成功也不报 failed——
        // 用户的输入没问题，是我们的数据没到位（决策：completed_partial 是一等公民）
        await jobs.complete(p.jobId, {
          missing: s3.status === "completed_partial"
            ? [{ item: "发型候选", reason: "风格数据（StyleProfileEntry）尚未就绪" }]
            : [{ item: "发型候选", reason: "确定性过滤后无合适候选" }],
        });
        return { status: "completed_partial", detail: { candidates: 0 } };
      }

      // ── S4 发型预览（串行，顺序=匹配度降序）──
      await step(p.jobId, "rendering");
      const s4 = await runWithSingleRetry(
        renderPreviewsStep,
        {
          baselinePhotoStorageKey: front.storageKey,
          candidates: await withChangeInstructions(s3.data.hairstyleCandidates, "hairstyle"),
          kind: "hairstyle",
        },
        planCtx,
        deps,
      );
      if (s4.status === "failed") {
        // 图片没出来但文字推荐已经推给用户了，收成部分成功而非 failed——
        // 报 failed 会让客户端把已读到的推荐也丢掉
        await jobs.complete(p.jobId, { missing: [{ item: "发型效果图", reason: s4.error }] });
        return { status: "completed_partial", detail: { reason: s4.error } };
      }
      await jobs.complete(p.jobId, { missing: s4.status === "completed_partial" ? s4.missing : undefined });
      return { status: s4.status, detail: { previews: s4.data.previews.length } };
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
      // 协调性由风格向量确定性计算（决策 2），不问 LLM
      const compatible = hairstyle
        ? outfits.filter(
            (o) =>
              Math.abs(o.formality - hairstyle.formality) <= 3 &&
              Math.abs(o.maturity - hairstyle.maturity) <= 3 &&
              Math.abs(o.boldness - hairstyle.boldness) <= 3 &&
              Math.abs(o.upkeep - hairstyle.upkeep) <= 3,
          )
        : outfits;

      const weight = plan.femaleAppealWeight;
      const candidates: ScoredCandidate[] = compatible
        .map((o) => ({
          entryId: o.id,
          nameZh: o.nameZh,
          femaleAppealScore: o.femaleAppealScore,
          maleSelfAppealScore: o.maleSelfAppealScore,
          appealGap: o.femaleAppealScore - o.maleSelfAppealScore,
          gapWorthDisclosing: Math.abs(o.femaleAppealScore - o.maleSelfAppealScore) >= 3,
          weightedScore: o.femaleAppealScore * weight + o.maleSelfAppealScore * (1 - weight),
          rationale: o.femaleAppealRationale,
        }))
        .sort((a, b) => b.weightedScore - a.weightedScore)
        .slice(0, 3);

      await step(p.jobId, "rendering");
      const s4b = await runWithSingleRetry(
        renderOutfitPreviewsStep,
        {
          fullBodyPhotoStorageKey: fullBody?.storageKey,
          candidates: await withChangeInstructions(candidates, "outfit"),
        },
        ctx,
        deps,
      );
      if (s4b.status === "failed") {
        await jobs.fail(p.jobId, `S4′ 失败: ${s4b.error}`);
        return { status: "failed" };
      }
      await jobs.mergePartialResult(p.jobId, {
        outfit: { mode: s4b.data.mode, previews: s4b.data.previews, degradedNotice: s4b.data.degradedNotice },
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
      const allSelected = profile?.domainSelections ?? [];
      // 只拿**目录驱动**的领域来过滤方法目录。发型/穿搭由 StyleProfileEntry 经
      // S3/S4 处理，不在目录里；混进来只会永远匹配不到（见 data/domains.ts）
      // Set<string> 而非 Set<CatalogDomain>：右侧比较的 c.domain 是库里的自由字符串，
      // 收窄成联合类型只会让比较处报错，收窄的价值在过滤那一步已经拿到了
      const catalogSelected = new Set<string>(allSelected.filter(isCatalogDomain));
      const styleSelected = allSelected.filter(isStyleDomain);

      const catalog = await prisma.candidateTaskCatalog.findMany({ where: { isRecommended: true } });
      const specs: MaterializeTaskSpec[] = catalog
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
      return handlers.stage_unlock_generation(p);
    },

    /** 进度复核：用视觉判断校准自报账本（决策 13）。 */
    async progress_recheck(p: JobPayload): Promise<OrchestratorResult> {
      if (!p.planId) {
        await jobs.fail(p.jobId, "缺少 planId");
        return { status: "failed" };
      }
      await step(p.jobId, "analyzing");
      const { front } = await loadPhotos(p.userId);
      const progressPhoto = await prisma.userPhoto.findFirst({
        where: { userId: p.userId, photoType: "progress", deletionStatus: "active" },
        orderBy: { uploadedAt: "desc" },
      });
      const photo = progressPhoto ?? front;
      if (!photo) {
        await jobs.fail(p.jobId, "缺少进度照片");
        return { status: "failed" };
      }

      const s2 = await runWithSingleRetry(
        analyzeVisionStep,
        { frontPhotoStorageKey: photo.storageKey },
        { jobId: p.jobId, userId: p.userId, planId: p.planId },
        deps,
      );

      // 未发生的变化描述：优先用调用方传入的判断；没传则从视觉语义里推断不出来，
      // 那就当作「无法判定」交给 reconcile 保持 unverified，而不是瞎猜成 rolled_back
      const unverified = p.unverifiedDescriptions ?? [];
      const r = await planRevision.reconcileManifest({ planId: p.planId, unverifiedDescriptions: unverified });
      await jobs.mergePartialResult(p.jobId, {
        recheck: { ...r, visionAvailable: s2.status !== "failed" },
      });
      await jobs.complete(p.jobId);
      return { status: "completed", detail: r as unknown as Record<string, unknown> };
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
