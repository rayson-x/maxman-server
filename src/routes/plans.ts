import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { env } from "../config/env.js";
import { requireUser } from "../plugins/session.js";
import { createRecommendationApplication } from "../services/recommendationApplication.js";
import { createStageProgressionService } from "../services/stageProgressionService.js";
import { createPhotoAccessService } from "../services/photoAccessService.js";
import { QUEUE_NAMES } from "../lib/queues.js";
import { enqueueCreatedAnalysisJob } from "../services/analysisJobEnqueueService.js";
import { reviewUserFreeText } from "../services/freeTextReview.js";

const statusUpdateSchema = z.object({
  status: z.enum(["pending", "done", "skipped", "blocked", "replaced"]),
});

const selectSchema = z.object({ styleTag: z.string().min(1) });
const styleDirectionSelectionSchema = z.object({ styleId: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,39}$/) });
const legacyStyleHairstyleSelectionSchema = z.object({
  styleId: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,39}$/),
  candidateId: z.string().min(1),
});
const customStyleDirectionSchema = z.object({ text: z.string().trim().min(2).max(200) });
const recommendationOutcomeSchema = z.object({
  outcomeType: z.enum(["saved", "slot_replaced", "explicitly_disliked", "try_on_saved", "finally_adopted"]),
  payload: z.record(z.string(), z.unknown()).optional(),
});

const selectableStyleDirectionSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,39}$/),
  nameZh: z.string().min(1).max(40),
  description: z.string().min(1).max(240),
  rationale: z.string().min(1).max(400),
});

export type SelectableStyleDirection = z.infer<typeof selectableStyleDirectionSchema>;

function seasonForDate(date: Date | null | undefined): "春" | "夏" | "秋" | "冬" {
  const month = (date ?? new Date()).getMonth() + 1;
  if (month >= 3 && month <= 5) return "春";
  if (month >= 6 && month <= 8) return "夏";
  if (month >= 9 && month <= 11) return "秋";
  return "冬";
}

/** 只信任最新成功首轮任务里 tool schema 已验证过的风格方向。 */
export function findSelectableStyleDirection(
  partialResult: unknown,
  styleId: string,
): SelectableStyleDirection | null {
  const rows = (partialResult as { styleRecommendations?: unknown } | null)?.styleRecommendations;
  if (!Array.isArray(rows)) return null;
  for (const row of rows) {
    const parsed = selectableStyleDirectionSchema.safeParse(row);
    if (parsed.success && parsed.data.id === styleId) return parsed.data;
  }
  return null;
}

type StyleSelectionEvidenceInput = {
  entryExists: boolean;
  kindMatches: boolean;
  isRecommended: boolean;
  source?: string | null;
  generatedForPlanId?: string | null;
  expectedPlanId?: string;
  offeredIds: string[];
  requestedEntryId: string;
};

export function evaluateStyleSelectionEvidence(
  input: StyleSelectionEvidenceInput,
):
  | { ok: true }
  | {
      ok: false;
      error:
        | "style_not_found"
        | "style_not_recommended"
        | "candidate_evidence_unavailable"
        | "not_in_candidates";
    } {
  if (!input.entryExists || !input.kindMatches) {
    return { ok: false, error: "style_not_found" };
  }
  const ownedGenerated =
    input.source === "vision_llm_generated" &&
    input.requestedEntryId.startsWith("llm-") &&
    Boolean(input.expectedPlanId) &&
    input.generatedForPlanId === input.expectedPlanId;
  if (!input.isRecommended && !ownedGenerated) {
    return { ok: false, error: "style_not_recommended" };
  }
  if (input.offeredIds.length === 0) {
    return { ok: false, error: "candidate_evidence_unavailable" };
  }
  if (!input.offeredIds.includes(input.requestedEntryId)) {
    return { ok: false, error: "not_in_candidates" };
  }
  return { ok: true };
}

/**
 * 方案读取与阶段推进路由（tasks 8.1-8.4, 8.9）。
 */
export async function registerPlanRoutes(app: FastifyInstance): Promise<void> {
  const { prisma } = app.container;
  const progression = createStageProgressionService(prisma);
  const photoAccess = createPhotoAccessService(prisma);

  /**
   * tasks 8.1：一次返回全部四阶段任务。
   * 决策 8 把懒生成改成一次全生成后，这里不再需要「未生成阶段只给骨架」的占位逻辑——
   * 用户从第一天就能看到完整路线图。
   */
  async function loadPlanPayload(planId: string, userId: string) {
    const plan = await prisma.appearancePlan.findFirst({
      where: { id: planId, userId },
      include: {
        stages: {
          orderBy: { stageIndex: "asc" },
          include: {
            tasks: { orderBy: { sortOrder: "asc" } },
            targetImages: { orderBy: { createdAt: "desc" } },
          },
        },
      },
    });
    if (!plan) return null;

    return {
      planId: plan.id,
      track: plan.track,
      status: plan.status,
      planVersion: plan.planVersion,
      currentStage: plan.currentStage,
      selectedHairstyleId: plan.selectedHairstyleId,
      selectedOutfitId: plan.selectedOutfitId,
      selectedStyle: plan.selectedStyle,
      stages: await Promise.all(
        plan.stages.map(async (stage) => {
          const { coreTotal, coreDone, allCoreDone } = await progression.evaluateStageUnlock(stage.id);
          const latestTargetImages = stage.targetImages.filter(
            (image, index, images) =>
              images.findIndex((candidate) => candidate.imageType === image.imageType) === index,
          );
          return {
            stageIndex: stage.stageIndex,
            windowLabel: stage.windowLabel,
            status: stage.status,
            completionPct: stage.completionPct,
            // 解锁进度实时算出，不读缓存字段
            coreProgress: { done: coreDone, total: coreTotal, allDone: allCoreDone },
            targetImages: await Promise.all(
              latestTargetImages.map(async (img) => ({
                imageType: img.imageType,
                readUrl: img.storageKey
                  ? (
                      await photoAccess.issueReadUrl({
                        storageKey: img.storageKey,
                        accessorType: "user",
                        accessorId: userId,
                        purpose: "用户查看阶段目标图",
                        expiresSeconds: 3600,
                      })
                    ).url
                  : null,
                qualityCheckStatus: img.qualityCheckStatus,
                // tasks 8.9：目标图必须带这条标注（决策 13）
                disclosure: "本图基于你勾选的完成情况生成，为模拟效果",
              })),
            ),
            tasks: stage.tasks.map((t) => ({
              taskId: t.id,
              domain: t.domain,
              priority: t.priority,
              evidenceBasis: t.evidenceBasis,
              taskType: t.taskType,
              selectionStatus: t.selectionStatus,
              candidateOptions: t.candidateOptions,
              styleTag: t.styleTag,
              title: t.title,
              estTime: t.estTime,
              estCost: t.estCost,
              rationale: t.rationale,
              status: t.status,
              sortOrder: t.sortOrder,
              // 核心任务不可跳过这条规则前端也要知道，避免给出一个点了就报错的按钮
              skippable: t.priority !== "core",
            })),
          };
        }),
      ),
    };
  }

  app.get("/plans/:planId", async (req, reply) => {
    const user = requireUser(req);
    const { planId } = req.params as { planId: string };
    const payload = await loadPlanPayload(planId, user.id);
    if (!payload) return reply.code(404).send({ error: "方案不存在" });
    return reply.send(payload);
  });

  /** tasks 8.1a：客户端不必先知道 plan id */
  app.get("/plans/current", async (req, reply) => {
    const user = requireUser(req);
    const active = await prisma.appearancePlan.findFirst({
      where: { userId: user.id, status: "active" },
      orderBy: { createdAt: "desc" },
    });
    if (!active) return reply.code(404).send({ error: "尚无活跃方案" });
    const payload = await loadPlanPayload(active.id, user.id);
    return reply.send(payload);
  });

  /**
   * 不需要等待出图的系统衣柜入口。它和 workflow / Agent 使用同一个 JSON 目录匹配器；
   * JSON 是系统内容，数据库只用于读取当前用户档案与已选风格。
   */
  app.get("/plans/:planId/wardrobe-recommendation", async (req, reply) => {
    const user = requireUser(req);
    const { planId } = req.params as { planId: string };
    const plan = await prisma.appearancePlan.findFirst({ where: { id: planId, userId: user.id } });
    if (!plan) return reply.code(404).send({ error: "方案不存在" });
    const styleId = (plan.selectedStyle as { id?: unknown } | null)?.id;
    if (typeof styleId !== "string") {
      return reply.code(422).send({ error: "style_not_selected", message: "请先选择一个风格方向" });
    }
    const [profile, event] = await Promise.all([
      prisma.appearanceProfile.findUnique({ where: { userId: user.id } }),
      prisma.event.findUnique({ where: { userId: user.id } }),
    ]);
    const recommender = createRecommendationApplication({
      prisma,
      hairstyleProvider: app.container.providers.hairstyleRecommendation,
      outfitProvider: app.container.providers.outfitRecommendation,
    });
    try {
      return reply.send(recommender.recommendWardrobe({
        heightCm: profile?.heightCm ?? null,
        weightKg: profile?.weightKg ?? null,
        faceShape: profile?.confirmedFaceShape ?? null,
        budgetTier: profile?.budgetTier ?? null,
        scene: event?.eventType ?? (plan.track === "long_term" ? "日常" : null),
        season: seasonForDate(event?.eventDate),
      }, { selectedStyleIds: [styleId], requestedLookCount: 3, includeSupply: true }));
    } catch {
      return reply.code(422).send({
        error: "style_not_in_system_wardrobe",
        message: "当前选择的自由风格尚未映射到系统衣柜，请从系统风格中重新选择",
      });
    }
  });

  /**
   * 用户从预览候选里选定发型/穿搭（决策 3 的两步约束选择）。
   *
   * 这个端点此前**完全缺失**：`selectedHairstyleId` 只被 `planRevisionService`
   * （换风格，tasks 9.x）写过，而 onboarding 的首次选定没有任何入口。后果是
   * `/outfit-previews` 与 `/materialize` 的「未选发型」校验永远为真，两个端点
   * 恒定 422，整条 onboarding 走不到穿搭那一步。
   *
   * **只接受出现在推荐候选里的 entryId**，不接受任意 id。理由是确定性过滤
   * （脸型适配 + 发际线/发量组合规则，决策 6）存在的意义就是把不合适的挡在外面；
   * 若客户端能提交任意 id，过滤引擎就被绕过了，用户可能选到一个我们明确判断
   * 会暴露发际线问题的发型。候选集以最近一次分析 job 的审计轨迹为准。
   */
  /**
   * 用户从候选集里选定发型或穿搭（两步约束选择的落点）。
   *
   * 归属与状态校验都在 `RecommendationApplication.selectCandidate` 里：
   * 候选必须属于当前用户、且所属集合为 `ready`。
   * 旧实现按 `StyleProfileEntry.id` 加上翻 job 的 `partialResult` 找候选集——
   * 现在候选有稳定的 `candidateId`，不需要那套间接查找。
   */
  async function selectRecommendationCandidate(
    req: FastifyRequest,
    reply: FastifyReply,
    expectedKind?: "hairstyle" | "outfit",
  ) {
    const user = requireUser(req);
    const { planId } = req.params as { planId: string };
    const { candidateId } = req.body as { candidateId?: string };
    if (!candidateId) return reply.code(400).send({ error: "需要 candidateId" });

    const app2 = createRecommendationApplication({
      prisma,
      hairstyleProvider: app.container.providers.hairstyleRecommendation,
      outfitProvider: app.container.providers.outfitRecommendation,
    });
    const result = await app2.selectCandidate({ userId: user.id, planId, candidateId, expectedKind });

    if (!result.ok) {
      const code = result.reason === "not_found" ? 404 : 422;
      const message = {
        not_found: "候选不存在",
        not_owned: "该候选不属于你的方案",
        set_not_ready: "候选集尚未就绪或已被新一轮推荐取代",
        style_not_selected: "请先选定一个风格方向",
        hairstyle_not_selected: "请先选定发型方向",
        style_not_offered: "该风格方向不在当前首轮推荐中",
        candidate_not_in_selected_style: "该发型不属于当前选定的风格方向",
      }[result.reason];
      return reply.code(code).send({ error: result.reason, message });
    }
    return reply.send({ ok: true, candidateId: result.candidateId, nameZh: result.nameZh });
  }

  /** A hairstyle can only be selected after its style direction has been persisted. */
  app.post("/plans/:planId/select-hairstyle", (req, reply) => selectRecommendationCandidate(req, reply, "hairstyle"));

  /** Wardrobe selection is the final selection stage. */
  app.post("/plans/:planId/select-outfit", (req, reply) => selectRecommendationCandidate(req, reply, "outfit"));

  /** Compatibility alias for the pre-rollout client. New clients use explicit domain endpoints above. */
  app.post("/plans/:planId/select-style", (req, reply) => {
    if (env.server.dualSourceRecommendationEnabled) {
      return reply.code(410).send({ error: "deprecated_candidate_selection", message: "请使用 select-hairstyle 或 select-outfit" });
    }
    return selectRecommendationCandidate(req, reply);
  });

  /** 首轮 3–4 个风格方向的选择落点；选择后才能选发型或请求穿搭。 */
  app.post("/plans/:planId/select-style-direction", async (req, reply) => {
    const user = requireUser(req);
    const { planId } = req.params as { planId: string };
    const { styleId } = styleDirectionSelectionSchema.parse(req.body);
    const plan = await prisma.appearancePlan.findFirst({ where: { id: planId, userId: user.id } });
    if (!plan) return reply.code(404).send({ error: "方案不存在" });

    const job = await prisma.analysisJob.findFirst({
      where: {
        userId: user.id,
        planId,
        jobType: "initial_analysis",
        status: { in: ["completed", "completed_partial"] },
      },
      orderBy: { createdAt: "desc" },
      select: { partialResult: true },
    });
    const style = findSelectableStyleDirection(job?.partialResult, styleId);
    if (!style) {
      return reply.code(422).send({
        error: "style_not_offered",
        message: "该风格方向不在当前首轮推荐中，请重新查看分析结果后选择",
      });
    }

    const updated = await prisma.$transaction(async (tx) => {
      const current = await tx.appearancePlan.findFirst({
        where: { id: planId, userId: user.id },
        select: { selectedStyle: true },
      });
      if (!current) return false;
      const previousStyleId = (current.selectedStyle as { id?: unknown } | null)?.id;
      if (previousStyleId !== style.id) {
        // The new three-stage flow lets a user deliberately change style. All
        // downstream selections and generations are then stale by definition;
        // preserving them would create an impossible cross-style state.
        await tx.appearancePlan.update({
          where: { id: planId },
          data: {
            selectedStyle: style as never,
            selectedHairstyleId: null,
            selectedOutfitId: null,
          },
        });
        await tx.recommendationSet.updateMany({
          where: { planId, kind: { in: ["hairstyle", "outfit"] }, status: { in: ["preparing", "ready", "failed"] } },
          data: { status: "superseded" },
        });
        await tx.generatedAsset.updateMany({
          where: {
            planId,
            kind: { in: ["hairstyle_preview", "outfit_preview"] },
            status: "active",
          },
          data: { status: "invalidated" },
        });
      } else {
        await tx.appearancePlan.update({ where: { id: planId }, data: { selectedStyle: style as never } });
      }
      await tx.conversationDecision.create({
        data: { planId, decisionKind: "style_direction_selected", payload: style as never },
      });
      // Style directions are comparison/exposure snapshots rather than legacy
      // RecommendationCandidate rows. Match the exact exposed canonical ID so
      // this remains behavioral evidence with a real exposure denominator.
      const comparison = await tx.recommendationComparisonLog.findFirst({
        where: { planId, userId: user.id, domain: "style" },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      if (comparison) {
        const exposures = await tx.recommendationExposure.findMany({
          where: { comparisonId: comparison.id },
          select: { id: true, candidateSnapshot: true },
        });
        const exposure = exposures.find((row) =>
          (row.candidateSnapshot as { canonicalId?: unknown }).canonicalId === style.id,
        );
        if (exposure) {
          await tx.recommendationChoice.upsert({
            where: { comparisonId_exposureId: { comparisonId: comparison.id, exposureId: exposure.id } },
            create: { comparisonId: comparison.id, exposureId: exposure.id },
            update: {},
          });
        }
      }
      return true;
    });
    if (!updated) {
      return reply.code(422).send({
        error: "candidate_not_in_selected_style",
        message: "方案状态已变化，请重新选择风格方向",
      });
    }
    return reply.send({ ok: true, style });
  });

  /** Compatibility endpoint retained only while the rollout flag is disabled. */
  app.post("/plans/:planId/select-style-hairstyle", async (req, reply) => {
    const user = requireUser(req);
    if (env.server.dualSourceRecommendationEnabled) {
      return reply.code(410).send({
        error: "deprecated_atomic_selection",
        message: "请先选择风格方向，再从该风格的发型候选中选择，最后选择穿搭",
      });
    }
    const { planId } = req.params as { planId: string };
    const { styleId, candidateId } = legacyStyleHairstyleSelectionSchema.parse(req.body);
    const result = await prisma.$transaction(async (tx) => {
      const plan = await tx.appearancePlan.findFirst({
        where: { id: planId, userId: user.id },
        select: { id: true },
      });
      if (!plan) return { ok: false as const, reason: "not_owned" as const };
      const job = await tx.analysisJob.findFirst({
        where: {
          userId: user.id,
          planId,
          jobType: "initial_analysis",
          status: { in: ["completed", "completed_partial"] },
        },
        orderBy: { createdAt: "desc" },
        select: { partialResult: true },
      });
      const style = findSelectableStyleDirection(job?.partialResult, styleId);
      if (!style) return { ok: false as const, reason: "style_not_offered" as const };
      const candidate = await tx.recommendationCandidate.findUnique({ where: { id: candidateId }, include: { set: true } });
      if (!candidate) return { ok: false as const, reason: "not_found" as const };
      if (candidate.set.planId !== planId) return { ok: false as const, reason: "not_owned" as const };
      if (candidate.set.kind !== "hairstyle" || candidate.set.status !== "ready") {
        return { ok: false as const, reason: "set_not_ready" as const };
      }
      if (candidate.styleDirectionId !== style.id) {
        return { ok: false as const, reason: "candidate_not_in_selected_style" as const };
      }
      await tx.appearancePlan.update({
        where: { id: planId },
        data: { selectedStyle: style as never, selectedHairstyleId: candidate.id },
      });
      await tx.conversationDecision.createMany({
        data: [
          { planId, decisionKind: "style_direction_selected", payload: style as never },
          { planId, decisionKind: "hairstyle_selected", payload: { kind: "hairstyle", candidateId: candidate.id, nameZh: candidate.nameZh } },
        ],
      });
      return { ok: true as const, candidateId: candidate.id, nameZh: candidate.nameZh };
    });
    if (!result.ok) {
      return reply.code(result.reason === "not_found" ? 404 : 422).send({ error: result.reason });
    }
    return reply.send({ ok: true, styleId, candidateId: result.candidateId, nameZh: result.nameZh });
  });

  /**
   * Only explicit, high-signal actions are recorded as outcomes. Views,
   * scrolling, and dwell time intentionally have no endpoint or database row.
   */
  app.post("/recommendation-exposures/:exposureId/outcomes", async (req, reply) => {
    const user = requireUser(req);
    const { exposureId } = req.params as { exposureId: string };
    const input = recommendationOutcomeSchema.parse(req.body);
    const exposure = await prisma.recommendationExposure.findFirst({
      where: { id: exposureId, comparison: { userId: user.id } },
      select: { id: true, comparisonId: true },
    });
    if (!exposure) return reply.code(404).send({ error: "recommendation_exposure_not_found" });
    const outcome = await prisma.recommendationOutcome.create({
      data: {
        comparisonId: exposure.comparisonId,
        exposureId: exposure.id,
        outcomeType: input.outcomeType,
        payload: (input.payload ?? undefined) as never,
      },
    });
    return reply.code(201).send({ outcomeId: outcome.id, outcomeType: outcome.outcomeType, occurredAt: outcome.occurredAt });
  });

  /**
   * 自定义风格方向（方案 A：与固定的 3-4 个方向**并列**，不是替代）。
   *
   * 走的是和 `POST /intake/hair-intent` **同一条双层审核链路**
   * （见 services/freeTextReview.ts）——自由文本要驱动下游出图，不能直接透传。
   *
   * 通过后**追加进首轮结果的 styleRecommendations**，而不是另开一条选择通道：
   * `select-style-direction` 的合法性判定以"首轮提供过什么"为唯一依据，
   * 另开通道等于绕过它。
   */
  app.post("/plans/:planId/custom-style-direction", async (req, reply) => {
    const user = requireUser(req);
    const { planId } = req.params as { planId: string };
    const { text } = customStyleDirectionSchema.parse(req.body);
    const trimmed = text.trim();

    const plan = await prisma.appearancePlan.findFirst({ where: { id: planId, userId: user.id } });
    if (!plan) return reply.code(404).send({ error: "方案不存在" });

    const job = await prisma.analysisJob.findFirst({
      where: {
        userId: user.id,
        planId,
        jobType: "initial_analysis",
        status: { in: ["completed", "completed_partial"] },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, partialResult: true },
    });
    if (!job) {
      return reply.code(422).send({
        error: "no_first_round",
        message: "还没有完成分析，无法追加风格方向",
      });
    }

    const review = await reviewUserFreeText(trimmed, app.log);
    if (!review.accepted) {
      return reply.code(review.status).send({
        accepted: false,
        reason: review.reason,
        category: review.category,
        message: review.message,
        ...(review.layer ? { layer: review.layer } : {}),
        ...(review.reviewUnavailable ? { reviewUnavailable: true } : {}),
      });
    }

    /*
     * 用户自述的方向**必须可辨识**：下游展示时要标注它不是我们的推荐，
     * 效果仅供参考（与 hair-intent 的 labelAsUserSpecified 同一口径）。
     */
    const direction = {
      id: "custom-user-specified",
      nameZh: trimmed.length <= 12 ? trimmed : `${trimmed.slice(0, 11)}…`,
      description: trimmed.slice(0, 240),
      rationale: "你自己描述的方向。不在我们的推荐库内，效果仅供参考",
    };

    const existing = (job.partialResult ?? {}) as Record<string, unknown>;
    const offered = Array.isArray(existing.styleRecommendations)
      ? (existing.styleRecommendations as unknown[])
      : [];
    // 覆盖同 id 的旧自述方向，避免用户改了几次就攒出一堆
    const merged = [
      ...offered.filter((d) => (d as { id?: string })?.id !== direction.id),
      direction,
    ];

    await prisma.$transaction([
      prisma.analysisJob.update({
        where: { id: job.id },
        data: { partialResult: { ...existing, styleRecommendations: merged } as never },
      }),
      prisma.conversationDecision.create({
        data: {
          planId,
          decisionKind: "custom_style_direction_submitted",
          payload: { text: trimmed, secondLayerReviewed: review.secondLayerReviewed } as never,
        },
      }),
    ]);

    return reply.send({
      accepted: true,
      style: direction,
      labelAsUserSpecified: true,
      secondLayerReviewed: review.secondLayerReviewed,
    });
  });

  /** tasks 8.2/8.3：任务状态更新，完成时自动写账本 */
  app.post("/plans/:planId/tasks/:taskId/status", async (req, reply) => {
    const user = requireUser(req);
    const { planId, taskId } = req.params as { planId: string; taskId: string };
    const input = statusUpdateSchema.parse(req.body);

    const plan = await prisma.appearancePlan.findFirst({ where: { id: planId, userId: user.id } });
    if (!plan) return reply.code(404).send({ error: "方案不存在" });

    const result = await progression.updateTaskStatus({ taskId, planId, nextStatus: input.status });
    if (!result.ok) {
      return reply.code(result.code === "task_not_found" ? 404 : 422).send({
        error: result.code,
        message: result.reason,
      });
    }

    // 阶段解锁时触发目标图生成（tasks 7.6）。AnalysisJob row 是最小 outbox：
    // 如果 Queue.add 失败，done 请求重放会找到原 created job 并用稳定 BullMQ
    // jobId 重投，而不是因为 task 已经是 done 就永远漏掉目标图。
    let generationJob: {
      id: string;
      stageId: string | null;
      errorReason: string | null;
    } | null = null;
    let generationRequeued = false;
    if (result.stageUnlocked && result.unlockedStageIndex !== undefined) {
      const nextStage = await prisma.stage.findFirst({
        where: { planId, stageIndex: result.unlockedStageIndex },
      });
      if (nextStage) {
        generationJob =
          await prisma.analysisJob.findFirst({
            where: {
              userId: user.id,
              planId,
              stageId: nextStage.id,
              jobType: "stage_unlock_generation",
              status: "created",
            },
            orderBy: { createdAt: "desc" },
          }) ??
          await prisma.analysisJob.create({
            data: {
              userId: user.id,
              planId,
              stageId: nextStage.id,
              jobType: "stage_unlock_generation",
            },
          });
      }
    } else if (input.status === "done") {
      // updateTaskStatus 的同状态重放是成功 no-op，因此 stageUnlocked=false。
      // 只恢复明确记录过入队失败的 created job；正常已投递 job 不做多余 add。
      generationJob = await prisma.analysisJob.findFirst({
        where: {
          userId: user.id,
          planId,
          jobType: "stage_unlock_generation",
          status: "created",
          errorReason: { startsWith: "queue_enqueue_failed:" },
        },
        orderBy: { createdAt: "desc" },
      });
      generationRequeued = Boolean(generationJob);
    }

    if (generationJob?.stageId) {
      const enqueued = await enqueueCreatedAnalysisJob({
        prisma,
        queue: app.container.queues.queues[QUEUE_NAMES.imageGeneration],
        jobName: "stage_unlock_generation",
        job: generationJob,
        payload: {
          userId: user.id,
          planId,
          stageId: generationJob.stageId,
        },
      });
      if (!enqueued.ok) {
        return reply.code(503).send({
          error: "queue_unavailable",
          message: "阶段已解锁，但目标图任务暂时无法投递；请重试本次状态请求",
          retryable: true,
          taskStatus: result.status,
          stageUnlocked: result.stageUnlocked,
          unlockedStageIndex: result.unlockedStageIndex,
          generationJobId: generationJob.id,
        });
      }
    }

    return reply.send({
      ok: true,
      status: result.status,
      manifestEntryCreated: result.manifestEntryCreated,
      stageUnlocked: result.stageUnlocked,
      unlockedStageIndex: result.unlockedStageIndex,
      generationJobId: generationJob?.id,
      generationRequeued,
    });
  });

  /** tasks 8.4：guided_selection 选定 */
  app.post("/plans/:planId/tasks/:taskId/select", async (req, reply) => {
    const user = requireUser(req);
    const { planId, taskId } = req.params as { planId: string; taskId: string };
    const input = selectSchema.parse(req.body);

    const plan = await prisma.appearancePlan.findFirst({ where: { id: planId, userId: user.id } });
    if (!plan) return reply.code(404).send({ error: "方案不存在" });

    const result = await progression.selectOption({ taskId, planId, styleTag: input.styleTag });
    if (!result.ok) return reply.code(422).send({ error: "selection_failed", message: result.reason });

    return reply.send({
      ok: true,
      styleTag: result.styleTag,
      // 明确回给客户端：选定不等于完成
      taskStatus: result.statusUnchanged,
      note: "已记录你选定的方向。等你实际完成之后再标记这个任务为完成。",
    });
  });

  /** 目标图生成输入的调试端点——便于核对决策 4 的口径 */
  app.get("/plans/:planId/stages/:stageIndex/target-image-input", async (req, reply) => {
    const user = requireUser(req);
    const { planId, stageIndex } = req.params as { planId: string; stageIndex: string };
    const plan = await prisma.appearancePlan.findFirst({ where: { id: planId, userId: user.id } });
    if (!plan) return reply.code(404).send({ error: "方案不存在" });
    const stage = await prisma.stage.findFirst({ where: { planId, stageIndex: Number(stageIndex) } });
    if (!stage) return reply.code(404).send({ error: "阶段不存在" });

    const input = await progression.buildTargetImageInput(planId, stage.id);
    if (!input) return reply.code(422).send({ error: "缺少基准照片" });
    return reply.send(input);
  });
}
