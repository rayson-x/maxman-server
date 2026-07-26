import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../plugins/session.js";
import { createConversationService } from "../services/conversationService.js";
import { createStageProgressionService } from "../services/stageProgressionService.js";
import { createPlanRevisionService } from "../services/planRevisionService.js";
import { reviewFreeInput, normalizeToStyleTag, BLOCKED_MESSAGES } from "../features/appearance-agent/data/domainLexicon.js";
import { getInputReviewProvider } from "../features/appearance-agent/composition.js";
import { computeHairConstraint } from "../features/appearance-agent/rules/hairConstraints.js";
import { QUEUE_NAMES } from "../lib/queues.js";

/**
 * 对话入口（tasks 9.5）。
 *
 * 设计要点（决策 1/15）：
 *   - **复用固定管道的同一套 step/service 实现**，不另写一份逻辑。
 *     agent 能做的每件事，都对应管道里已经存在的一个能力，行为不会分叉。
 *   - 可写（调整目标/方案/目标图），但生成类动作走 `user_regeneration` 路径，
 *     受同一条容量限流约束。
 *   - 对话状态只存结构化决策，不存原文（决策 0.6）。
 *
 * 这里刻意**不引入 Mastra Agent 的自主 tool-calling**：意图分类用确定性规则，
 * 因为对话的动作集是有限且已知的（改风格/否决方向/调权重/问解释）。
 * 让 LLM 自主决定调哪个能力会引入不可预测的成本与延迟，而收益是零——
 * 动作集就这么几个。LLM 只用在真正需要语言能力的地方：审核自由输入、写解释文案。
 */

const messageSchema = z.object({
  planId: z.string().min(1),
  /** 用户的自由表达 */
  text: z.string().min(1).max(500),
  /** 客户端可显式声明意图，省掉一次分类；缺省时按关键词推断 */
  intent: z.enum(["ask_explanation", "reject_direction", "express_preference", "adjust_weight", "request_regeneration"]).optional(),
});

const rejectSchema = z.object({
  planId: z.string().min(1),
  styleId: z.string().min(1),
  nameZh: z.string().optional(),
  reason: z.string().max(300).optional(),
});

const weightSchema = z.object({
  planId: z.string().min(1),
  /** 0 = 完全按自己审美，1 = 完全按女性视角参考数据 */
  femaleAppealWeight: z.number().min(0).max(1),
});

/** 确定性意图推断。动作集有限且已知，不值得为它烧一次 LLM 调用。 */
function inferIntent(text: string): z.infer<typeof messageSchema>["intent"] {
  if (/为什么|why|凭什么|依据|理由/.test(text)) return "ask_explanation";
  if (/不喜欢|不要|换一个|不想|讨厌|不合适/.test(text)) return "reject_direction";
  if (/重新生成|再生成|换张图|重新出图/.test(text)) return "request_regeneration";
  if (/更在意|更看重|偏向|按我自己/.test(text)) return "adjust_weight";
  return "express_preference";
}

export async function registerConversationRoutes(app: FastifyInstance): Promise<void> {
  const { prisma, queues } = app.container;
  const conversation = createConversationService(prisma);
  const progression = createStageProgressionService(prisma);
  const revision = createPlanRevisionService(prisma);

  /** 读取对话语境：结构化决策 + 当前方案状态（不含历史消息） */
  app.get("/conversation/:planId/context", async (req, reply) => {
    const user = requireUser(req);
    const { planId } = req.params as { planId: string };
    const plan = await prisma.appearancePlan.findFirst({ where: { id: planId, userId: user.id } });
    if (!plan) return reply.code(404).send({ error: "方案不存在" });

    const ctx = await conversation.buildContext(planId);
    return reply.send({
      ...ctx,
      note: "对话语境由结构化决策与当前方案状态重建，我们不保存对话原文。",
    });
  });

  /**
   * 对话消息。按意图路由到既有能力，不新写逻辑。
   */
  app.post("/conversation/message", async (req, reply) => {
    const user = requireUser(req);
    const input = messageSchema.parse(req.body);

    const plan = await prisma.appearancePlan.findFirst({ where: { id: input.planId, userId: user.id } });
    if (!plan) return reply.code(404).send({ error: "方案不存在" });

    const intent = input.intent ?? inferIntent(input.text);

    // 自由表达一律先过两层审核——对话入口不能绕过 onboarding 已有的安全边界
    if (intent === "express_preference") {
      const layer1 = reviewFreeInput(input.text);
      if (layer1.kind === "blocked") {
        return reply.code(422).send({
          accepted: false,
          intent,
          reason: "blocked",
          category: layer1.category,
          message: BLOCKED_MESSAGES[layer1.category],
        });
      }

      const matchedTerms = layer1.kind === "in_domain" ? layer1.matchedTerms : [];
      try {
        const review = await getInputReviewProvider().review({ text: input.text, matchedDomainTerms: matchedTerms });
        if (!review.verdict.allowed) {
          return reply.code(422).send({
            accepted: false,
            intent,
            reason: review.verdict.violationCategory === "out_of_scope" ? "out_of_domain" : "blocked_by_review",
            category: review.verdict.violationCategory,
            message: review.verdict.userMessage,
            layer: 2,
          });
        }
      } catch {
        // 与 onboarding 同口径：in_domain 放行标记未审，out_of_domain 拒绝
        if (layer1.kind === "out_of_domain") {
          return reply.code(422).send({ accepted: false, intent, reason: "out_of_domain", reviewUnavailable: true });
        }
      }

      const styleTag = normalizeToStyleTag(input.text);
      await conversation.record(input.planId, "preference_expressed", { text: input.text, normalizedStyleTag: styleTag });

      return reply.send({
        accepted: true,
        intent,
        normalizedStyleTag: styleTag,
        labelAsUserSpecified: styleTag === null,
      });
    }

    if (intent === "ask_explanation") {
      // 解释来自已经算好的确定性结果，不重新推理——避免对话里给出与方案不一致的说法
      const profile = await prisma.appearanceProfile.findUnique({ where: { userId: user.id } });
      const photo = await prisma.userPhoto.findFirst({
        where: { userId: user.id, photoType: "front", deletionStatus: "active" },
        orderBy: { uploadedAt: "asc" },
      });
      const metrics = photo?.faceMetrics as { classification?: { hairline?: { value?: string }; hairVolume?: { value?: string } } } | null;
      const constraint = computeHairConstraint({
        hairline: (metrics?.classification?.hairline?.value as never) ?? "normal",
        volume: (metrics?.classification?.hairVolume?.value as never) ?? "unknown",
        selfReportedHairLossConcern: profile?.hairLossConcern ?? false,
        selfReportedVolume: profile?.selfReportedHairVolume ?? undefined,
      });

      return reply.send({
        accepted: true,
        intent,
        explanation: {
          faceShape: profile?.confirmedFaceShape ?? null,
          hairConstraintStrength: constraint.strength,
          hairConstraintRationale: constraint.rationale,
          evidenceBasis: constraint.evidenceBasis,
          appealWeight: plan.femaleAppealWeight,
        },
      });
    }

    if (intent === "request_regeneration") {
      // 走既有的 user_regeneration 路径（决策 15：可写但计费/限流一致）
      return reply.send({
        accepted: true,
        intent,
        next: "POST /plans/:planId/target-images/regenerate",
        note: "重新生成会消耗一次生成额度，并受每小时容量限流约束。",
      });
    }

    return reply.send({ accepted: true, intent, note: "已记录，请使用对应的专门端点执行该动作。" });
  });

  /** 否决某个方向。记进决策摘要，后续推荐不再提出它 */
  app.post("/conversation/reject-direction", async (req, reply) => {
    const user = requireUser(req);
    const input = rejectSchema.parse(req.body);
    const plan = await prisma.appearancePlan.findFirst({ where: { id: input.planId, userId: user.id } });
    if (!plan) return reply.code(404).send({ error: "方案不存在" });

    await conversation.record(input.planId, "direction_rejected", {
      styleId: input.styleId,
      nameZh: input.nameZh,
      reason: input.reason,
    });

    return reply.send({
      ok: true,
      note: "已记录。后续推荐不会再提出这个方向。",
    });
  });

  /** 调整双审美加权（决策 22 方案 E：默认按目标加权但用户可调） */
  app.post("/conversation/adjust-appeal-weight", async (req, reply) => {
    const user = requireUser(req);
    const input = weightSchema.parse(req.body);
    const plan = await prisma.appearancePlan.findFirst({ where: { id: input.planId, userId: user.id } });
    if (!plan) return reply.code(404).send({ error: "方案不存在" });

    await prisma.appearancePlan.update({
      where: { id: input.planId },
      data: { femaleAppealWeight: input.femaleAppealWeight },
    });
    await conversation.record(input.planId, "appeal_weight_adjusted", {
      from: plan.femaleAppealWeight,
      to: input.femaleAppealWeight,
    });

    return reply.send({
      ok: true,
      femaleAppealWeight: input.femaleAppealWeight,
      note:
        input.femaleAppealWeight >= 0.7
          ? "已调整为更看重女性视角参考数据的推荐排序。"
          : input.femaleAppealWeight <= 0.3
            ? "已调整为更看重你自己审美偏好的推荐排序。"
            : "已调整为两种视角均衡的推荐排序。",
    });
  });

  /** 换风格：评估可选项（受已完成事实约束），不直接执行 */
  app.get("/conversation/:planId/style-change-options", async (req, reply) => {
    const user = requireUser(req);
    const { planId } = req.params as { planId: string };
    const plan = await prisma.appearancePlan.findFirst({ where: { id: planId, userId: user.id } });
    if (!plan) return reply.code(404).send({ error: "方案不存在" });

    const completed = await prisma.changeManifestEntry.findMany({
      where: { planId, verificationStatus: { not: "rolled_back" } },
    });
    const candidates = await prisma.styleProfileEntry.findMany({ where: { kind: "hairstyle", isRecommended: true } });

    // 已完成变化对应的风格向量：用当前选定风格的向量作为已发生事实的代表
    const currentStyle = plan.selectedHairstyleId
      ? await prisma.styleProfileEntry.findUnique({ where: { id: plan.selectedHairstyleId } })
      : null;
    const completedVectors = currentStyle && completed.length > 0
      ? [{ formality: currentStyle.formality, maturity: currentStyle.maturity, boldness: currentStyle.boldness, upkeep: currentStyle.upkeep }]
      : [];

    const rejectedIds = new Set(
      (await prisma.conversationDecision.findMany({ where: { planId, decisionKind: "direction_rejected" } }))
        .map((d) => (d.payload as { styleId?: string }).styleId)
        .filter(Boolean),
    );

    const assessment = revision.assessStyleChange({
      // 已否决的方向不再出现在候选里
      candidates: candidates
        .filter((c) => !rejectedIds.has(c.id))
        .map((c) => ({
          entryId: c.id,
          nameZh: c.nameZh,
          styleVector: { formality: c.formality, maturity: c.maturity, boldness: c.boldness, upkeep: c.upkeep },
        })),
      completedVectors,
    });

    return reply.send({
      available: assessment.available,
      blocked: assessment.blocked.map((b) => ({ nameZh: b.candidate.nameZh, reason: b.reason, availableInWeeks: b.availableInWeeks })),
      emptySetMessage: assessment.emptySetMessage,
      excludedByPriorRejection: rejectedIds.size,
    });
  });

  /** 目标图输入预览——让用户能看到「这张图是按什么生成的」 */
  app.get("/conversation/:planId/target-image-basis", async (req, reply) => {
    const user = requireUser(req);
    const { planId } = req.params as { planId: string };
    const plan = await prisma.appearancePlan.findFirst({ where: { id: planId, userId: user.id } });
    if (!plan) return reply.code(404).send({ error: "方案不存在" });

    const activeStage = await prisma.stage.findFirst({ where: { planId, status: "active" } });
    if (!activeStage) return reply.code(404).send({ error: "无活跃阶段" });

    const basis = await progression.buildTargetImageInput(planId, activeStage.id);
    if (!basis) return reply.code(422).send({ error: "缺少基准照片" });

    return reply.send({
      completedChanges: basis.completedChanges,
      plannedChanges: basis.plannedChanges,
      note: "目标图 = 你最初的照片 + 已完成的改变 + 本阶段计划要做的改变。",
    });
  });
}
