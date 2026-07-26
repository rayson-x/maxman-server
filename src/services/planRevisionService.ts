import type { PrismaClient } from "../generated/prisma/client.js";
import { checkCompatibility, DEFAULT_COMPATIBILITY_THRESHOLD, type StyleVector } from "../features/appearance-agent/data/styleProfile.js";

/**
 * 方案修订（tasks 9.1-9.4）。
 *
 * 核心是**换风格受已完成事实约束**（design.md 决策 14）：
 *   - 已完成的 `ChangeManifestEntry` 全部保留——事实不可撤销（他真的剪了那个头发）
 *   - 新风格候选集受已完成变化的**向量兼容性**约束，复用同一套计算，零新增概念
 *   - 过滤到空集不是缺陷而是正确行为：已剪寸头却想换成需要中长发的风格，
 *     真相就是他得等头发长出来。此时给**时间预期**而非一句"不行"
 */

/** 头发长度恢复速度：约 1cm/月，据此估算等待时间 */
const HAIR_GROWTH_CM_PER_MONTH = 1;

export type StyleChangeCandidate = {
  entryId: string;
  nameZh: string;
  styleVector: StyleVector;
  /** 该风格需要的最短头发长度（cm）。为 null 表示无长度要求 */
  requiredHairLengthCm?: number | null;
};

export type StyleChangeAssessment = {
  available: StyleChangeCandidate[];
  blocked: {
    candidate: StyleChangeCandidate;
    reason: string;
    /** 需要等待时才有值 */
    availableInWeeks?: number;
  }[];
  /** 全部被挡时给用户的说明——把物理约束转成时间预期 */
  emptySetMessage?: string;
};

export function createPlanRevisionService(prisma: PrismaClient) {
  return {
    /**
     * 评估可换的风格（tasks 9.1/9.2）。
     *
     * @param completedVectors 已完成变化对应的风格向量（如已剪的发型）
     * @param currentHairLengthCm 当前头发长度估计，用于算等待时间
     */
    assessStyleChange(params: {
      candidates: StyleChangeCandidate[];
      completedVectors: StyleVector[];
      currentHairLengthCm?: number;
      threshold?: number;
    }): StyleChangeAssessment {
      const threshold = params.threshold ?? DEFAULT_COMPATIBILITY_THRESHOLD;
      const available: StyleChangeCandidate[] = [];
      const blocked: StyleChangeAssessment["blocked"] = [];

      for (const c of params.candidates) {
        // 1. 头发长度这类**物理不可逆**约束优先判断——向量兼容也没用，头发就是不够长
        if (c.requiredHairLengthCm != null && params.currentHairLengthCm != null) {
          const deficit = c.requiredHairLengthCm - params.currentHairLengthCm;
          if (deficit > 0) {
            const months = deficit / HAIR_GROWTH_CM_PER_MONTH;
            blocked.push({
              candidate: c,
              reason: `这个方向需要约 ${c.requiredHairLengthCm}cm 的头发长度，你目前约 ${params.currentHairLengthCm}cm`,
              availableInWeeks: Math.ceil(months * 4.3),
            });
            continue;
          }
        }

        // 2. 向量兼容性：新风格不能和已完成的变化差太远
        const incompatibleWith = params.completedVectors
          .map((v) => checkCompatibility(c.styleVector, v, threshold))
          .find((r) => !r.compatible);
        if (incompatibleWith) {
          blocked.push({
            candidate: c,
            reason: `与你已经完成的改变风格差异过大（${incompatibleWith.violations.map((v) => `${v.dimension}差${v.delta}`).join("、")}）`,
          });
          continue;
        }

        available.push(c);
      }

      // 空集时把物理约束转成时间预期，而不是一句"不行"
      let emptySetMessage: string | undefined;
      if (available.length === 0 && blocked.length > 0) {
        const waitable = blocked.filter((b) => b.availableInWeeks != null).sort((a, b) => a.availableInWeeks! - b.availableInWeeks!);
        if (waitable.length > 0) {
          const soonest = waitable[0];
          emptySetMessage =
            `现在能换的方向暂时没有——「${soonest.candidate.nameZh}」这类方向需要更长的头发，` +
            `按每月长约 1cm 估算，大约 ${soonest.availableInWeeks} 周后可以考虑。` +
            `在那之前，我们可以先从穿搭和仪容方向调整整体感觉。`;
        } else {
          emptySetMessage =
            "现在能换的方向暂时没有——你已经完成的改变与其余风格方向差异都比较大。" +
            "可以先保持当前方向，或者从穿搭方向做调整。";
        }
      }

      return { available, blocked, emptySetMessage };
    },

    /**
     * 执行换风格（tasks 9.1）。
     * 已完成账本全部保留，未完成的风格任务被替换，`plan_version` 递增。
     */
    async applyStyleChange(params: {
      planId: string;
      newHairstyleId: string;
      newOutfitId?: string;
    }): Promise<{ ok: true; planVersion: number; retainedEntries: number; replacedTasks: number } | { ok: false; reason: string }> {
      const plan = await prisma.appearancePlan.findUnique({ where: { id: params.planId } });
      if (!plan) return { ok: false, reason: "方案不存在" };

      // 已完成账本条数——换风格不动它们（事实不可撤销）
      const retainedEntries = await prisma.changeManifestEntry.count({
        where: { planId: params.planId, verificationStatus: { not: "rolled_back" } },
      });

      // 未完成的风格衍生任务标记为 replaced。
      // 注意只标 hair/outfit 域——非风格任务（护肤/健身）与风格无关，不该被换风格波及。
      const toReplace = await prisma.stageTask.findMany({
        where: {
          stage: { planId: params.planId },
          domain: { in: ["hair", "outfit"] },
          status: { notIn: ["done", "replaced"] },
        },
      });
      for (const t of toReplace) {
        await prisma.stageTask.update({ where: { id: t.id }, data: { status: "replaced" } });
      }

      const updated = await prisma.appearancePlan.update({
        where: { id: params.planId },
        data: {
          selectedHairstyleId: params.newHairstyleId,
          selectedOutfitId: params.newOutfitId ?? plan.selectedOutfitId,
          // 决策 14：递增而非重置——这是同一方案的演进，不是新方案
          planVersion: { increment: 1 },
        },
      });

      return { ok: true, planVersion: updated.planVersion, retainedEntries, replacedTasks: toReplace.length };
    },

    /**
     * 非风格任务的同领域等价替换（tasks 9.4）。
     * 与换风格不同：这是单个任务的替换，不影响风格协调性。
     */
    async replaceNonStyleTask(params: { taskId: string; planId: string }): Promise<
      { ok: true; replacedTaskId: string; newTaskId: string } | { ok: false; reason: string; code: string }
    > {
      const task = await prisma.stageTask.findFirst({
        where: { id: params.taskId, stage: { planId: params.planId } },
      });
      if (!task) return { ok: false, reason: "任务不存在", code: "task_not_found" };

      // 决策 14：风格衍生任务不能单独替换——单独换掉发型会破坏风格协调性，
      // 那是决策 2/3 花力气保证的东西。必须走换风格流程。
      if (task.domain === "hair" || task.domain === "outfit") {
        return {
          ok: false,
          code: "must_change_style",
          reason: "发型和穿搭是同一套风格的两半，单独替换会破坏搭配协调性。请通过「换风格」来调整。",
        };
      }

      // 从同领域取一个等价候选（排除已在本方案中出现过的）
      const usedTitles = (
        await prisma.stageTask.findMany({
          where: { stage: { planId: params.planId }, domain: task.domain },
          select: { title: true },
        })
      ).map((t) => t.title);

      const alternative = await prisma.candidateTaskCatalog.findFirst({
        where: { domain: task.domain, isRecommended: true, methodName: { notIn: usedTitles } },
      });
      if (!alternative) {
        return { ok: false, code: "no_alternative", reason: `${task.domain} 领域暂时没有其他可替换的方案` };
      }

      await prisma.stageTask.update({ where: { id: task.id }, data: { status: "replaced" } });
      const created = await prisma.stageTask.create({
        data: {
          stageId: task.stageId,
          domain: task.domain,
          priority: task.priority,
          evidenceBasis: alternative.evidenceBasis,
          title: alternative.methodName,
          estTime: alternative.estTime,
          estCost: alternative.estCostRange,
          rationale: alternative.description,
          changeDescription: alternative.description,
          sortOrder: task.sortOrder,
        },
      });

      return { ok: true, replacedTaskId: task.id, newTaskId: created.id };
    },

    /**
     * 账本校准（tasks 9.x / 决策 13）。
     * 发现偏差时**修正账本**而非指责用户，并重新生成目标图。
     */
    async reconcileManifest(params: {
      planId: string;
      /** 视觉分析认为**实际未发生**的变化描述 */
      unverifiedDescriptions: string[];
    }): Promise<{ rolledBack: number; verified: number; planVersion: number }> {
      const entries = await prisma.changeManifestEntry.findMany({
        where: { planId: params.planId, verificationStatus: "unverified" },
      });

      let rolledBack = 0;
      let verified = 0;
      for (const e of entries) {
        const looksUndone = params.unverifiedDescriptions.some(
          (d) => e.changeDescription.includes(d) || d.includes(e.changeDescription),
        );
        await prisma.changeManifestEntry.update({
          where: { id: e.id },
          data: {
            verificationStatus: looksUndone ? "rolled_back" : "verified",
            verifiedAt: new Date(),
          },
        });
        looksUndone ? rolledBack++ : verified++;
      }

      // 回退的条目对应的任务也要退回 pending——否则任务显示已完成但账本说没做，两边矛盾
      if (rolledBack > 0) {
        const rolledBackEntries = await prisma.changeManifestEntry.findMany({
          where: { planId: params.planId, verificationStatus: "rolled_back" },
          select: { sourceTaskId: true },
        });
        const taskIds = rolledBackEntries.map((e) => e.sourceTaskId).filter((id): id is string => Boolean(id));
        if (taskIds.length > 0) {
          await prisma.stageTask.updateMany({ where: { id: { in: taskIds } }, data: { status: "pending" } });
        }
      }

      const updated = await prisma.appearancePlan.update({
        where: { id: params.planId },
        data: { planVersion: { increment: 1 } },
      });

      return { rolledBack, verified, planVersion: updated.planVersion };
    },
  };
}

export type PlanRevisionService = ReturnType<typeof createPlanRevisionService>;
