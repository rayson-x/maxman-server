import type { AppContainer } from "./container.js";
import type { AgentWeatherContext } from "../features/appearance-agent/weather/types.js";
import { photoModerationWhere } from "../lib/photoModerationGate.js";
import { env } from "../config/env.js";
import { QUEUE_NAMES } from "../lib/queues.js";
import type { PrismaClient } from "../generated/prisma/client.js";
import { createAnalysisJobRepository } from "../repositories/analysisJobRepository.js";
import { createTargetImageService } from "../services/targetImageService.js";
import { createPlanRevisionService } from "../services/planRevisionService.js";
import { moderateInputStep } from "../steps/moderateInput.js";
import { analyzeVisionStep } from "../steps/analyzeVision.js";
import { recommendStep } from "../steps/recommend.js";
import { createRecommendationApplication } from "../services/recommendationApplication.js";
import { renderOutfitPreviewsStep } from "../steps/renderPreviews.js";
import { materializePlanStep, type MaterializeTaskSpec } from "../steps/materializePlan.js";
import { runWithSingleRetry, type StepContext, type StepDeps } from "../steps/types.js";
import { isCatalogDomain, isStyleDomain } from "../features/appearance-agent/data/domains.js";
import { deriveTaskDimensions } from "../features/appearance-agent/data/taskDimensions.js";
import { buildSelectedStyleTaskSpecs } from "../services/selectedStyleTaskService.js";
import { verifyProgressStep } from "../steps/verifyProgress.js";
import { DEFAULT_COMPATIBILITY_THRESHOLD } from "../features/appearance-agent/data/styleProfile.js";
import { createPhotoAccessService } from "../services/photoAccessService.js";
import { createDualSourceWorkflowApplication } from "../features/dual-source-recommendation/workflowApplication.js";
import {
  checkCompatibility,
  resolveStyleEntryByName,
  toStyleVector,
} from "../features/appearance-agent/data/styleProfile.js";

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

type Season = "春" | "夏" | "秋" | "冬";

function seasonForDate(date: Date | null | undefined): Season {
  const month = (date ?? new Date()).getMonth() + 1;
  if (month >= 3 && month <= 5) return "春";
  if (month >= 6 && month <= 8) return "夏";
  if (month >= 9 && month <= 11) return "秋";
  return "冬";
}

export type SeasonBasis = "forecast" | "live_apparent" | "live_actual" | "monthly_normal" | "calendar";

/**
 * 按**目标日期当地的真实气温**定季节，而不是日历月份。
 *
 * 这是收集省/市的全部意义所在：北京 10 月和广州 10 月按日历都是「秋」，
 * 实际是 15°C 与 28°C——同一句「适合秋季」的穿搭建议对其中一个必然是错的。
 * `recommendWardrobe` 的打分只吃一个粗粒度 season 字符串（`recommend.ts:17`
 * 按 `item.usage.seasons.includes(profile.season)` 加 18 分），所以要让天气
 * 影响用户可见的输出，就得改这个入参本身，而不只是往 prompt 里塞天气。
 *
 * **取温必须对齐目标日期，不能一律用"今天"。** 这个坑是实跑时才暴露的：
 * 最初实现无条件优先用实时体感，于是「10 月的活动」在 7 月查询时拿到 32°C，
 * 判成夏——给三个月后的秋季活动推了夏装。所以按目标日期分三档：
 *
 *   1. 目标日在预报窗口内 → 用该日预报的当日均温（(min+max)/2）
 *   2. 目标日就是最近几天但预报里没有 → 用实时体感/气温
 *   3. 目标日更远（或无活动日期但实时不可用）→ 用**目标月**的历史均温
 *
 * 体感优先于实测气温，因为穿衣决策看的是体感（风和湿度都算进去了）；
 * 但体感只有"现在"有，所以它只在第 2 档生效。
 *
 * 温度分档用中国气象习惯（日均温）：<10°C 冬，≥22°C 夏，中间是过渡季。
 * **过渡季无法只靠温度区分春秋**——15°C 可能是升温中的春也可能是降温中的秋，
 * 方向信息只有月份有，所以这一档用目标月份给方向。
 */
export function seasonFromWeather(
  weather: AgentWeatherContext | undefined,
  eventDate: Date | null | undefined,
  now: Date = new Date(),
): { season: Season; basis: SeasonBasis } {
  const target = eventDate ?? now;
  const targetMonth = target.getMonth() + 1;
  const calendar = seasonForDate(target);
  if (!weather) return { season: calendar, basis: "calendar" };

  const live = weather.live;
  const liveUsable = live?.status !== "unavailable";
  const dayMs = 24 * 60 * 60 * 1000;
  const daysAhead = Math.floor((target.getTime() - now.getTime()) / dayMs);

  // ① 预报窗口内：用目标日自己的预报，而不是今天的实时值
  const targetKey = target.toISOString().slice(0, 10);
  const forecast = liveUsable ? live.daily.find((d) => d.date === targetKey) : undefined;

  const monthly = weather.historical?.months.find((m) => m.month === targetMonth);

  const picked: { tempC: number; basis: Exclude<SeasonBasis, "calendar"> } | null = forecast
    ? { tempC: (forecast.tempMinC + forecast.tempMaxC) / 2, basis: "forecast" }
    : // ② 目标日在两天内才认实时值——再远就与"现在"无关了
      daysAhead <= 1 && liveUsable && typeof live.apparentTempC === "number"
      ? { tempC: live.apparentTempC, basis: "live_apparent" }
      : daysAhead <= 1 && liveUsable && typeof live.currentTempC === "number"
        ? { tempC: live.currentTempC, basis: "live_actual" }
        : // ③ 远期：目标月的历史均温
          typeof monthly?.typicalMeanC === "number"
          ? { tempC: monthly.typicalMeanC, basis: "monthly_normal" }
          : null;

  if (!picked) return { season: calendar, basis: "calendar" };
  if (picked.tempC < 10) return { season: "冬", basis: picked.basis };
  if (picked.tempC >= 22) return { season: "夏", basis: picked.basis };

  /*
   * 过渡带（10-22°C）：温度本身分不出春秋，需要**升温还是降温**这个方向信号。
   * 有历史月度数据时就用相邻月均温的差来定；比硬编码「上半年算春」准得多。
   *
   * 硬编码版本的实际错例：广州 1 月均温约 14°C 落在过渡带，按「月份≤7 判春」
   * 得到「春」——而那是广州全年最冷的月份，方向上离冬更近。用 12 月→1 月的
   * 降温趋势判「秋」，穿衣重量上才对。
   *
   * 拿不到相邻月数据时才回落到月份切分。
   */
  const prevMonth = targetMonth === 1 ? 12 : targetMonth - 1;
  const prevMean = weather.historical?.months.find((m) => m.month === prevMonth)?.typicalMeanC;
  const thisMean = monthly?.typicalMeanC;
  const trend =
    typeof prevMean === "number" && typeof thisMean === "number" ? thisMean - prevMean : null;

  if (trend !== null && trend !== 0) {
    return { season: trend > 0 ? "春" : "秋", basis: picked.basis };
  }
  return { season: targetMonth <= 7 ? "春" : "秋", basis: picked.basis };
}

/**
 * 把用户自报的省/市解析成城市级天气上下文，供穿搭推荐用。
 *
 * **必须永不抛错。** 天气是纯增益上下文：拿不到就退回原来的行为（prompt 里
 * 【天气】为空对象），绝不能把一条本来能跑通的推荐链路变成会失败的链路。
 * 三种拿不到的情况都同等对待：
 *   - 用户没填省市（`intake` 里两者是可选且必须成对出现）
 *   - 容器没装天气服务（`withProviders: false`）
 *   - Open-Meteo 解析/取数失败或超时
 *
 * ⚠ `build()` 内部对历史与实时是 `allSettled`，单边失败会返回 `historical: null`
 * 或 `live.status: "unavailable"`，那属于**部分可用**，照常传下去——
 * 让模型看到"实时不可用但月度均温在"，比整块丢掉更有用。
 *
 * 超时上限刻意设得比 provider 默认更紧：这一步挂住会直接拖长用户等待，
 * 而它的价值远低于主链路。
 */
const WEATHER_RESOLVE_TIMEOUT_MS = 6000;

async function resolveWeatherContext(
  weatherContext: AppContainer["weatherContext"],
  profile: { province?: string | null; city?: string | null } | null,
  log?: (msg: string, detail?: unknown) => void,
): Promise<AgentWeatherContext | undefined> {
  const province = profile?.province?.trim();
  const city = profile?.city?.trim();
  if (!weatherContext || !province || !city) return undefined;

  try {
    return await Promise.race<AgentWeatherContext>([
      weatherContext.build({ province, city }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`weather resolve timeout ${WEATHER_RESOLVE_TIMEOUT_MS}ms`)), WEATHER_RESOLVE_TIMEOUT_MS),
      ),
    ]);
  } catch (error) {
    // 记录但不上抛。天气缺失不构成部分成功缺口——它不是用户要的产物。
    log?.("天气上下文解析失败，按无天气继续", {
      province,
      city,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

export function createJobOrchestrator(container: AppContainer) {
  const prisma: PrismaClient = container.prisma;
  const jobs = createAnalysisJobRepository(prisma);
  const targetImages = createTargetImageService(prisma, container.providers);
  const planRevision = createPlanRevisionService(prisma);
  const photoAccess = createPhotoAccessService(prisma);
  const dualSourceWorkflow = env.server.dualSourceRecommendationEnabled
    ? createDualSourceWorkflowApplication(prisma, {
        enqueueReviewer: async (comparisonId) => {
          const queue = container.queues.queues[QUEUE_NAMES.textAnalysis];
          if (!queue) throw new Error("reviewer_queue_unavailable");
          await queue.add("dual_source_reviewer", { comparisonId }, {
            jobId: `dual-source-reviewer:${comparisonId}`,
          });
        },
      })
    : null;
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

  /**
   * A job retry must retain its generation and therefore its immutable
   * comparison/exposure history. A later job after an upstream selection
   * change receives the next generation, so stale downstream sets cannot be
   * confused with the newly conditioned result.
   */
  async function dualSourceGeneration(
    planId: string,
    domain: "style" | "hairstyle" | "wardrobe",
    computationKey: string,
  ): Promise<number> {
    const sameJob = await prisma.recommendationComparisonLog.findFirst({
      where: { planId, domain, computationKey },
      select: { generation: true },
    });
    if (sameJob) return sameJob.generation;

    const previous = await prisma.recommendationComparisonLog.aggregate({
      where: { planId, domain },
      _max: { generation: true },
    });
    return (previous._max.generation ?? 0) + 1;
  }

  const handlers = {
    /**
     * S1 → S2 → 建方案 → S3（风格—发型组合）。
     * 首轮结束即写回 partialResult；图像预览不再抢在用户选择组合之前生成。
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

      // ── 首轮 Agent 的确定性输入准备（不调用模型） ──
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
      // ── 建方案（首轮候选需要 planId 才能以同一事务落库）──
      const plan = await ensurePlan(p.userId);
      await prisma.analysisJob.update({ where: { id: p.jobId }, data: { planId: plan.id } });
      const planCtx: StepContext = { ...ctx, planId: plan.id };

      // ── S3 推荐 ──
      await step(p.jobId, "recommending");
      if (dualSourceWorkflow) {
        const styleResult = await dualSourceWorkflow.recommendStyleDirections({
          userId: p.userId,
          planId: plan.id,
          jobId: p.jobId,
          generation: await dualSourceGeneration(plan.id, "style", `style:${p.jobId}`),
          originalPhotos: [front, ...(fullBody ? [fullBody] : [])],
          profileSnapshotRef: `appearance-profile:${p.userId}:${profile?.updatedAt.toISOString() ?? "missing"}`,
          appearanceAnalysisRef: `analysis-job:${p.jobId}:vision-v1`,
          questionnaireSnapshotRef: profile ? `appearance-profile:${profile.id}:${profile.updatedAt.toISOString()}` : undefined,
          selectedUpstream: {},
          userContext: {
            geometry: s2.data.geometry,
            hairSignals: s2.data.hairSignals,
            clientSignals: s2.data.clientSignals,
            body: profile ? {
              heightCm: profile.heightCm,
              weightKg: profile.weightKg,
              bodyFatPercent: profile.bodyFatPercent,
              shoulderWidthCm: profile.shoulderWidthCm,
              chestCm: profile.chestCm,
              waistCm: profile.waistCm,
              thighCm: profile.thighCm,
              exercisesRegularly: profile.exercisesRegularly,
              budgetTier: profile.budgetTier,
              changeWillingness: profile.changeWillingness,
            } : {},
            visualBodyEvidence: fullBody ? "available" : "missing",
          },
        });
        const styleRecommendations = [...styleResult.main, ...styleResult.exploration].map((candidate) => ({
          id: candidate.canonicalId,
          nameZh: candidate.nameZh,
          description: candidate.rationale,
          rationale: candidate.rationale,
        }));
        const vision = {
          geometry: s2.data.geometry,
          hairSignals: s2.data.hairSignals,
          clientSignals: s2.data.clientSignals,
          structuredSemantic: {},
          hasFullBody: s2.data.hasFullBody,
        };
        await jobs.mergePartialResult(p.jobId, {
          planId: plan.id,
          vision,
          faceAnalysis: null,
          styleRecommendations,
          styleRecommendation: {
            candidates: [...styleResult.main, ...styleResult.exploration],
            degradation: styleResult.audit.degradation,
          },
        });
        if (styleRecommendations.length === 0) {
          await jobs.complete(p.jobId, { missing: [{ item: "风格候选", reason: "未产出可展示的风格方向" }] });
          return { status: "completed_partial", detail: { candidates: 0 } };
        }
        await jobs.complete(p.jobId);
        return { status: "completed", detail: { candidates: styleRecommendations.length } };
      }
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
      const firstRound = s3.data.firstRound;
      const vision = {
        geometry: s2.data.geometry,
        hairSignals: s2.data.hairSignals,
        clientSignals: s2.data.clientSignals,
        structuredSemantic: firstRound?.faceAnalysis.structuredSemantic ?? {},
        hasFullBody: s2.data.hasFullBody,
      };

      if (s3.data.candidates.length === 0) {
        await jobs.mergePartialResult(p.jobId, {
          planId: plan.id,
          vision,
          faceAnalysis: firstRound?.faceAnalysis ?? null,
          styleRecommendations: firstRound?.styleRecommendations ?? [],
          recommendation,
        });
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

      // 首轮只落地可选择的风格—发型组合。未选前不为全部候选出图，避免把用户
      // 尚未决定的方向变成图像生成成本，也避免 UI 看起来“先出发型图再选风格”。
      await jobs.mergePartialResult(p.jobId, {
        planId: plan.id,
        vision,
        faceAnalysis: firstRound?.faceAnalysis ?? null,
        styleRecommendations: firstRound?.styleRecommendations ?? [],
        recommendation,
      });

      const missing = s3.status === "completed_partial" ? s3.missing : [];
      await jobs.complete(p.jobId, { missing: missing.length > 0 ? missing : undefined });
      return {
        status: missing.length > 0 ? "completed_partial" : "completed",
        detail: { candidates: s3.data.candidates.length },
      };
    },

    /** Second waiting point: only an explicit style may start hairstyle recall. */
    async hairstyle_recommendation(p: JobPayload): Promise<OrchestratorResult> {
      if (!dualSourceWorkflow || !p.planId) {
        await jobs.fail(p.jobId, "双源发型推荐当前未启用或缺少 planId");
        return { status: "failed" };
      }
      const ctx: StepContext = { jobId: p.jobId, userId: p.userId, planId: p.planId };
      const [plan, profile, photos, prior] = await Promise.all([
        prisma.appearancePlan.findFirst({ where: { id: p.planId, userId: p.userId } }),
        prisma.appearanceProfile.findUnique({ where: { userId: p.userId } }),
        loadPhotos(p.userId),
        prisma.analysisJob.findFirst({
          where: { userId: p.userId, planId: p.planId, jobType: "initial_analysis", status: { in: ["completed", "completed_partial"] } },
          orderBy: { createdAt: "desc" },
          select: { id: true, partialResult: true },
        }),
      ]);
      const styleId = (plan?.selectedStyle as { id?: unknown } | null)?.id;
      if (!plan || typeof styleId !== "string") {
        await jobs.fail(p.jobId, "尚未选定风格方向，无法推荐发型");
        return { status: "failed" };
      }
      if (!photos.front) {
        await jobs.fail(p.jobId, "缺少正面照");
        return { status: "failed" };
      }
      const vision = (prior?.partialResult as { vision?: { geometry?: unknown; hairSignals?: unknown; clientSignals?: unknown } } | null)?.vision;
      const hairSignals = vision?.hairSignals as import("../features/appearance-agent/rules/hairConstraints.js").HairSignals | undefined;
      if (!hairSignals) {
        await jobs.fail(p.jobId, "缺少已保存的发际线与发量信号");
        return { status: "failed" };
      }
      await step(p.jobId, "recommending");
      const result = await dualSourceWorkflow.recommendHairstyles({
        userId: p.userId,
        planId: p.planId,
        jobId: p.jobId,
        generation: await dualSourceGeneration(p.planId, "hairstyle", `hairstyle:${p.jobId}`),
        originalPhotos: [photos.front],
        profileSnapshotRef: `appearance-profile:${p.userId}:${profile?.updatedAt.toISOString() ?? "missing"}`,
        appearanceAnalysisRef: prior ? `analysis-job:${prior.id}:vision-v1` : undefined,
        questionnaireSnapshotRef: profile ? `appearance-profile:${profile.id}:${profile.updatedAt.toISOString()}` : undefined,
        selectedUpstream: { styleId },
        selectedStyleId: styleId,
        hairSignals,
        renderProvider: container.providers.imageEdit.name,
        renderModel: container.providers.imageEdit.name,
        userContext: {
          geometry: vision?.geometry ?? null,
          hairSignals,
          clientSignals: vision?.clientSignals ?? {},
          selectedStyle: plan.selectedStyle,
          visualBodyEvidence: "not_used_for_hairstyle",
        },
      });
      const set = await prisma.recommendationSet.findUnique({
        where: { computationKey: `dual-source:hairstyle:hairstyle:${p.jobId}` },
        include: { candidates: { orderBy: { rank: "asc" } } },
      });
      await jobs.mergePartialResult(p.jobId, {
        hairstyleRecommendation: {
          setId: set?.id ?? null,
          candidates: set?.candidates.map((candidate) => ({
            candidateId: candidate.id,
            nameZh: candidate.nameZh,
            description: candidate.description,
            modelRationale: candidate.modelRationale,
            styleDirectionId: candidate.styleDirectionId,
            verificationStatus: candidate.verificationStatus,
            renderReady: false,
          })) ?? [],
          catalogCoverage: "unknown",
          degradation: result.audit.degradation,
        },
      });
      if (!set || set.candidates.length === 0) {
        await jobs.complete(p.jobId, { missing: [{ item: "发型候选", reason: "未产出可选择候选" }] });
        return { status: "completed_partial", detail: { candidates: 0 } };
      }
      await jobs.complete(p.jobId);
      return { status: "completed", detail: { candidates: set.candidates.length } };
    },

    /** Third waiting point: wardrobe follows both persisted style and hairstyle choices. */
    async wardrobe_recommendation(p: JobPayload): Promise<OrchestratorResult> {
      if (!dualSourceWorkflow || !p.planId) {
        await jobs.fail(p.jobId, "双源穿搭推荐当前未启用或缺少 planId");
        return { status: "failed" };
      }
      const ctx: StepContext = { jobId: p.jobId, userId: p.userId, planId: p.planId };
      const [plan, profile, photos] = await Promise.all([
        prisma.appearancePlan.findFirst({ where: { id: p.planId, userId: p.userId } }),
        prisma.appearanceProfile.findUnique({ where: { userId: p.userId } }),
        loadPhotos(p.userId),
      ]);
      const styleId = (plan?.selectedStyle as { id?: unknown } | null)?.id;
      if (!plan || typeof styleId !== "string") {
        await jobs.fail(p.jobId, "尚未选定风格方向，无法推荐穿搭");
        return { status: "failed" };
      }
      if (!plan.selectedHairstyleId) {
        await jobs.fail(p.jobId, "尚未选定发型，无法推荐穿搭");
        return { status: "failed" };
      }
      if (!photos.front) {
        await jobs.fail(p.jobId, "缺少正面照");
        return { status: "failed" };
      }
      await step(p.jobId, "recommending");
      const result = await dualSourceWorkflow.recommendWardrobe({
        userId: p.userId,
        planId: p.planId,
        jobId: p.jobId,
        generation: await dualSourceGeneration(p.planId, "wardrobe", `wardrobe:${p.jobId}`),
        originalPhotos: [photos.front, ...(photos.fullBody ? [photos.fullBody] : [])],
        profileSnapshotRef: `appearance-profile:${p.userId}:${profile?.updatedAt.toISOString() ?? "missing"}`,
        questionnaireSnapshotRef: profile ? `appearance-profile:${profile.id}:${profile.updatedAt.toISOString()}` : undefined,
        selectedUpstream: { styleId, hairstyleCandidateId: plan.selectedHairstyleId },
        selectedStyleId: styleId,
        selectedHairstyleId: plan.selectedHairstyleId,
        userContext: {
          selectedStyle: plan.selectedStyle,
          selectedHairstyleCandidateId: plan.selectedHairstyleId,
          body: profile ? {
            heightCm: profile.heightCm,
            weightKg: profile.weightKg,
            bodyFatPercent: profile.bodyFatPercent,
            shoulderWidthCm: profile.shoulderWidthCm,
            chestCm: profile.chestCm,
            waistCm: profile.waistCm,
            thighCm: profile.thighCm,
            exercisesRegularly: profile.exercisesRegularly,
            budgetTier: profile.budgetTier,
          } : {},
          visualBodyEvidence: photos.fullBody ? "available" : "missing",
        },
      });
      const set = await prisma.recommendationSet.findUnique({
        where: { computationKey: `dual-source:wardrobe:wardrobe:${p.jobId}` },
        include: { candidates: { orderBy: { rank: "asc" } } },
      });
      await jobs.mergePartialResult(p.jobId, {
        wardrobeRecommendation: {
          setId: set?.id ?? null,
          candidates: set?.candidates.map((candidate) => ({
            candidateId: candidate.id,
            nameZh: candidate.nameZh,
            description: candidate.description,
            modelRationale: candidate.modelRationale,
            verificationStatus: candidate.verificationStatus,
          })) ?? [],
          visualBodyEvidence: photos.fullBody ? "available" : "missing",
          degradation: result.audit.degradation,
        },
      });
      if (!set || set.candidates.length === 0) {
        await jobs.complete(p.jobId, { missing: [{ item: "穿搭候选", reason: "未产出可选择候选" }] });
        return { status: "completed_partial", detail: { candidates: 0 } };
      }
      await jobs.complete(p.jobId);
      return { status: "completed", detail: { candidates: set.candidates.length } };
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
      if (!plan?.selectedStyle) {
        await jobs.fail(p.jobId, "尚未选定风格方向，无法生成穿搭候选");
        return { status: "failed" };
      }
      if (!plan.selectedHairstyleId) {
        await jobs.fail(p.jobId, "尚未选定发型，无法筛选穿搭候选");
        return { status: "failed" };
      }

      if (dualSourceWorkflow) {
        if (!plan.selectedOutfitId) {
          await jobs.fail(p.jobId, "尚未选定穿搭候选，无法生成预览");
          return { status: "failed" };
        }
        const selectedOutfit = await prisma.recommendationCandidate.findUnique({
          where: { id: plan.selectedOutfitId },
          include: { set: true },
        });
        if (!selectedOutfit || selectedOutfit.set.planId !== p.planId || selectedOutfit.set.kind !== "outfit") {
          await jobs.fail(p.jobId, "已选穿搭候选无效");
          return { status: "failed" };
        }
        // The current immutable wardrobe snapshot has no provider/model
        // calibrated personalized outfit render variant. Do not fall back to
        // the legacy free-form provider: textual selection remains valid.
        if (!selectedOutfit.renderInstruction) {
          await jobs.mergePartialResult(p.jobId, {
            outfit: {
              mode: "text_and_reference_only",
              previews: [{
                candidateId: selectedOutfit.id,
                nameZh: selectedOutfit.nameZh,
                storageKey: null,
                readUrl: null,
                latencyMs: 0,
                referenceOnly: true,
                rationale: selectedOutfit.modelRationale,
              }],
              supplementaryPrompt: "这套方案当前先以文字内容呈现。",
            },
          });
          await jobs.complete(p.jobId, {
            missing: [{ item: "本人穿搭预览图", reason: "所选候选缺少当前 provider/model 的渲染校准" }],
          });
          return { status: "completed_partial", detail: { candidates: 1, previewSkipped: true } };
        }
        await step(p.jobId, "rendering");
        const rendered = await runWithSingleRetry(
          renderOutfitPreviewsStep,
          {
            fullBodyPhotoStorageKey: fullBody?.storageKey,
            candidates: [{
              candidateId: selectedOutfit.id,
              nameZh: selectedOutfit.nameZh,
              renderInstruction: selectedOutfit.renderInstruction,
              modelRationale: selectedOutfit.modelRationale,
            }],
          },
          ctx,
          deps,
        );
        if (rendered.status === "failed") {
          await jobs.fail(p.jobId, `S4′ 失败: ${rendered.error}`);
          return { status: "failed" };
        }
        await jobs.mergePartialResult(p.jobId, {
          outfit: {
            mode: rendered.data.mode,
            previews: rendered.data.previews,
            supplementaryPrompt: rendered.data.supplementaryPrompt,
          },
        });
        await jobs.complete(p.jobId, { missing: rendered.status === "completed_partial" ? rendered.missing : undefined });
        return { status: rendered.status, detail: { candidates: 1 } };
      }

      /*
       * 风格协调：**当前不做确定性过滤，全部交给 LLM 判断**。
       *
       * 决策 2 原本要求「协调性编码在数据里，不靠 LLM 判断审美」，方向是对的，
       * 但前提是有足够的风格数据。实际库里只有 12 个发型 + 5 套穿搭——
       * 用四轴阈值过滤只能从一个本就很小的池子里再减（实测「微碎盖」筛完剩 4/5，
       * 换个正式度靠边的发型就可能剩 0-1 个），等于用没校准的阈值把候选饿死。
       *
       * 所以这一版：把**人脸信息 + 全量可选集合**交给 LLM，由它输出推荐，
       * 四轴只作为参考信息随集合一起给出、不参与计算。
       * 接缝保留不变——后续引入内部向量数据库时，替换的只是"集合怎么来"，
       * provider 的调用方式不动。
       *
       * ⚠ 这是对决策 2 的**有意放宽**，不是漏做。数据量上来后应回到确定性过滤。
       */
      const selectedCandidate = await prisma.recommendationCandidate.findUnique({
        where: { id: plan.selectedHairstyleId },
      });
      const hairstyleEntries = await prisma.styleProfileEntry.findMany({
        where: { kind: "hairstyle" },
      });
      // 按名称解析回风格表（候选表没有指向风格表的外键）。取不到就是模型自创的造型。
      const hairstyle = selectedCandidate
        ? resolveStyleEntryByName(hairstyleEntries, selectedCandidate.nameZh)
        : null;
      const hairVector = hairstyle ? toStyleVector(hairstyle) : null;

      /*
       * 人脸信息复用 initial_analysis 的 S2 结果，不重跑视觉分析：
       * 那一步要真调云端 vision（有成本），而穿搭这一步用的脸型/肤色/发量信号
       * 与当时完全相同。partialResult.vision 里存着 geometry / hairSignals /
       * structuredSemantic 三份。
       */
      const priorAnalysis = await prisma.analysisJob.findFirst({
        where: {
          userId: p.userId,
          planId: p.planId,
          jobType: "initial_analysis",
          status: { in: ["completed", "completed_partial"] },
        },
        orderBy: { createdAt: "desc" },
      });
      const visionForOutfit = (priorAnalysis?.partialResult as
        | { vision?: { geometry?: unknown; hairSignals?: unknown; structuredSemantic?: unknown } }
        | null
        | undefined)?.vision ?? null;

      const outfits = await prisma.styleProfileEntry.findMany({
        where: { kind: "outfit_combo", isRecommended: true },
      });
      // 全量给出，四轴附带作参考，不做筛选
      const outfitCatalog = outfits.map((o) => ({
        nameZh: o.nameZh,
        description: o.description ?? "",
        styleVector: toStyleVector(o),
      }));
      // 穿搭候选改由应用模块产出：不再从 StyleProfileEntry 按双审美评分筛选
      // （那份数据为空，会导致零候选并卡住 /materialize）
      const profileForOutfit = await prisma.appearanceProfile.findUnique({ where: { userId: p.userId } });
      const eventForOutfit = await prisma.event.findUnique({ where: { userId: p.userId } });
      // 天气按用户自报的省/市解析。失败/未填一律得到 undefined，不影响后续。
      const weatherForOutfit = await resolveWeatherContext(
        container.weatherContext,
        profileForOutfit,
        (msg, detail) => console.warn(`[job ${p.jobId}] ${msg}`, detail ?? ""),
      );
      // 季节按真实气温定，拿不到天气才回落日历。basis 记进日志便于核对
      // 「为什么给我推的是夏装」这类问题。
      const seasonForOutfit = seasonFromWeather(weatherForOutfit, eventForOutfit?.eventDate);
      console.info(
        `[job ${p.jobId}] 季节判定 ${seasonForOutfit.season}（依据 ${seasonForOutfit.basis}）`,
        weatherForOutfit ? { city: `${weatherForOutfit.province}${weatherForOutfit.city}` } : {},
      );
      const outfitApp = createRecommendationApplication({
        prisma,
        hairstyleProvider: container.providers.hairstyleRecommendation,
        outfitProvider: container.providers.outfitRecommendation,
      });
      const selectedStyleId = (plan.selectedStyle as { id?: unknown } | null)?.id;
      let systemWardrobe = null;
      if (typeof selectedStyleId === "string") {
        try {
          systemWardrobe = outfitApp.recommendWardrobe({
            heightCm: profileForOutfit?.heightCm ?? null,
            weightKg: profileForOutfit?.weightKg ?? null,
            faceShape: profileForOutfit?.confirmedFaceShape ?? null,
            hairVolume: (visionForOutfit?.hairSignals as { volume?: string } | null)?.volume ?? null,
            hairlineSignal: (visionForOutfit?.hairSignals as { hairline?: string } | null)?.hairline ?? null,
            budgetTier: profileForOutfit?.budgetTier ?? null,
            scene: eventForOutfit?.eventType ?? (plan.track === "long_term" ? "日常" : null),
            season: seasonForOutfit.season,
          }, { selectedStyleIds: [selectedStyleId], requestedLookCount: 3, includeSupply: true });
        } catch {
          // 旧首轮的自由风格 id 尚未映射到系统风格时，不让它阻断既有预览流程。
          systemWardrobe = null;
        }
      }
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
        /*
         * 天气：12 条月度均温摘要 + 实时/预报。此前 provider prompt 里
         * `【天气】` 恒为 `{}`——整套天气模块（Open-Meteo 接入、36 个月历史缓存、
         * 上下文装配）都实现了，但没有任何生产调用方传值，而用户已经在填省市。
         * 未填省市或解析失败时仍是 undefined，行为与接线前一致。
        */
        weather: weatherForOutfit,
        budgetTier: profileForOutfit?.budgetTier ?? null,
        // 有全身照才传，纯文字路径不签发照片地址
        fullBodyPhotoStorageKey: fullBody?.storageKey,
        // 全量可选集合（带四轴作参考，不作过滤条件）
        catalogVariants: outfitCatalog,
        // 人脸信息：穿搭此前完全拿不到，而版型/颜色本就该看脸型与肤色
        face: {
          geometry: visionForOutfit?.geometry ?? null,
          semantics: visionForOutfit?.structuredSemantic ?? null,
          hairSignals: visionForOutfit?.hairSignals ?? null,
          selectedHairstyleVector: hairVector,
          selectedStyle: plan.selectedStyle,
        },
        selectedStyle: plan.selectedStyle,
        workflow: { jobId: p.jobId, stepName: "S4_outfit_recommendation_provider" },
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
          // 用户可先看系统衣柜主搭/备选与槽位替换，再决定是否进入现有的真人预览候选。
          systemWardrobe,
          mode: s4b.data.mode,
          previews: s4b.data.previews,
          supplementaryPrompt: s4b.data.supplementaryPrompt,
          coordination: {
            available: false,
            method: "agent_judgement",
            reason:
              "风格数据量不足（12 发型 / 5 穿搭），本版不做确定性过滤，"
              + "由 LLM 基于人脸信息与全量可选集合判断；数据量上来后回到向量过滤",
            catalogSize: outfitCatalog.length,
            selectedHairstyleInCatalog: hairVector !== null,
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
          // 目录里为空就是"画不出来"，目标图会据此跳过这条
          renderDescription: c.renderDescription ?? undefined,
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
