import type { PrismaClient } from "../generated/prisma/client.js";

/**
 * 对话状态（tasks 9.5，决策 0.6）。
 *
 * **只存结构化决策摘要，不存对话原文。**
 *
 * 理由不是省存储：跨轮真正需要记住的是「已确认/已否决的决策」，而方案当前状态
 * 本来就在 `AppearancePlan` 里。存原文不但没有额外信息量，还带来隐私删除负担
 * （对话里可能夹带用户随口说的敏感信息，删账号时又要多一条级联链）。
 *
 * 代价要说清楚：丢失了自然语言上下文。用户说「刚才那个第二个方案」时，agent 无法
 * 凭原文回溯，只能靠结构化决策 + 当前方案状态重建语境。这是有意的取舍——
 * 换来的是对话内容零留存。
 */

export type DecisionKind =
  /** 用户选定了某个风格方向 */
  | "style_selected"
  /** 用户否决了某个方向（含原因，避免重复推荐） */
  | "direction_rejected"
  /** 调整了双审美加权（更看重异性视角 or 自我认同） */
  | "appeal_weight_adjusted"
  /** 用户表达了自由意向且已过审 */
  | "preference_expressed"
  /** 触发了一次重新生成 */
  | "regeneration_requested";

export type DecisionPayload = Record<string, unknown>;

export function createConversationService(prisma: PrismaClient) {
  return {
    async record(planId: string, kind: DecisionKind, payload: DecisionPayload) {
      return prisma.conversationDecision.create({
        data: { planId, decisionKind: kind, payload: payload as never },
      });
    },

    /**
     * 重建对话语境。返回的是**结构化决策 + 当前方案状态**，不是历史消息。
     * agent 用它来避免重复推荐已否决方向、理解用户当前处于哪一步。
     */
    async buildContext(planId: string) {
      const [decisions, plan] = await Promise.all([
        prisma.conversationDecision.findMany({
          where: { planId },
          orderBy: { createdAt: "asc" },
          take: 50,
        }),
        prisma.appearancePlan.findUnique({
          where: { id: planId },
          include: {
            stages: { orderBy: { stageIndex: "asc" }, include: { tasks: true } },
          },
        }),
      ]);
      if (!plan) return null;

      const rejected = decisions
        .filter((d) => d.decisionKind === "direction_rejected")
        .map((d) => d.payload as { styleId?: string; nameZh?: string; reason?: string });

      const activeStage = plan.stages.find((s) => s.status === "active");

      return {
        planId,
        planVersion: plan.planVersion,
        selectedHairstyleId: plan.selectedHairstyleId,
        selectedOutfitId: plan.selectedOutfitId,
        femaleAppealWeight: plan.femaleAppealWeight,
        currentStageIndex: plan.currentStage,
        activeStageTasks: (activeStage?.tasks ?? []).map((t) => ({
          taskId: t.id,
          title: t.title,
          priority: t.priority,
          status: t.status,
          selectionStatus: t.selectionStatus,
        })),
        /** 已否决的方向——agent 不该再把这些当新建议提出来 */
        rejectedDirections: rejected,
        decisionCount: decisions.length,
      };
    },

    /** 判断某方向是否已被否决过，避免重复推荐 */
    async wasRejected(planId: string, styleId: string): Promise<{ rejected: boolean; reason?: string }> {
      const decisions = await prisma.conversationDecision.findMany({
        where: { planId, decisionKind: "direction_rejected" },
      });
      for (const d of decisions) {
        const p = d.payload as { styleId?: string; reason?: string };
        if (p.styleId === styleId) return { rejected: true, reason: p.reason };
      }
      return { rejected: false };
    },
  };
}

export type ConversationService = ReturnType<typeof createConversationService>;
