import type { Step } from "./types.js";
import { computeRuleBasedCompositeScore } from "../features/appearance-agent/providers/planMaterialization/ruleBasedPlanMaterialization.js";

/**
 * S5 方案落地（tasks 5.8）。
 *
 * 两条关键设计（design.md 决策 7/8）：
 *
 * 1. **阶段落位由时间尺度决定，不由打分决定。** 阶段是任务的固有属性
 *    （剃胡须=10分钟→阶段0；健身见效=6-12周→阶段3），不是优先级的函数。
 *    「健身减脂」打分再高也塞不进"当天 10-30 分钟"的阶段 0。所以落位读
 *    `applicableStageRange`，打分只在**阶段内部**决定 core/optional 与排序。
 *
 * 2. **四个阶段的任务清单一次全生成。** 前一份 spec 定的懒生成理由是省成本，
 *    但落位改成数据驱动后这个理由反转了：一次全生成只需 1 次打分调用，
 *    分阶段懒生成要 4 次，反而贵约 4 倍。而**目标图**仍然懒生成——它的输入含
 *    已完成账本，提前生成时账本是空的，图就是错的（逻辑上不可能，不只是浪费）。
 */

export const STAGE_WINDOWS = ["当天 10-30 分钟", "1-7 天", "2-4 周", "6-12 周"] as const;

/** 阶段内 core/optional 的加权公式（决策 6）。权重可配置，起步用等权。 */
export type ScoringWeights = {
  visualBenefit: number;
  credibility: number;
  acceptance: number;
  reversibility: number;
  timeCost: number;
  moneyCost: number;
  risk: number;
};

export const DEFAULT_WEIGHTS: ScoringWeights = {
  visualBenefit: 1,
  credibility: 1,
  acceptance: 1,
  reversibility: 1,
  timeCost: 1,
  moneyCost: 1,
  risk: 1,
};

/** 综合分：收益项加、成本项减 */
export function computeCompositeScore(
  dims: { visualBenefit: number; credibility: number; acceptance: number; reversibility: number; timeCost: number; moneyCost: number; risk: number },
  w: ScoringWeights = DEFAULT_WEIGHTS,
): number {
  return computeRuleBasedCompositeScore(dims, w);
}

export type MaterializeTaskSpec = {
  domain: string;
  title: string;
  /** 决策 7：阶段落位读这个字段，如 ["stage0","stage1"] */
  applicableStageRange: string[];
  evidenceBasis: "visual_detected" | "self_reported" | "general_best_practice";
  changeDescription: string;
  /**
   * 目标图用的渲染文案。留空 = 这条在正面照里画不出来，不进图生图 prompt。
   * 与 changeDescription 分开：后者是给用户看的建议（含括号补充、否定式、
   * 破折号解释），直接喂图像模型会让 prompt 超长、指令跟随变差。
   */
  renderDescription?: string;
  estTime?: string;
  estCost?: string;
  rationale?: string;
  /** 已经由用户选定的风格目录 ID；用于任务与选择结果之间的可追溯关联。 */
  styleTag?: string;
  /** 打分维度。缺省时该任务不参与 core 竞争，直接 optional */
  dimensions?: { visualBenefit: number; credibility: number; acceptance: number; reversibility: number; timeCost: number; moneyCost: number; risk: number };
  /** guided_selection 任务的候选，每个候选带自己的 changeDescription（决策 11） */
  candidateOptions?: { styleTag: string; changeDescription: string }[];
};

export type MaterializePlanInput = {
  planId: string;
  tasks: MaterializeTaskSpec[];
  weights?: ScoringWeights;
  /** 每阶段最多几个 core 任务。core 太多会让阶段永远解锁不了 */
  maxCorePerStage?: number;
};

export type MaterializePlanOutput = {
  stages: { stageIndex: number; windowLabel: string; taskCount: number; coreCount: number; hasTargetImage: boolean }[];
  totalTasks: number;
};

function stageIndexFromRange(range: string[]): number {
  // 取范围内最早的阶段——任务能在阶段1做，就不要拖到阶段2
  const indices = range
    .map((s) => Number.parseInt(s.replace(/[^0-9]/g, ""), 10))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 3);
  return indices.length > 0 ? Math.min(...indices) : 1;
}

export const materializePlanStep: Step<MaterializePlanInput, MaterializePlanOutput> = {
  name: "S5_materialize_plan",
  async run(input, ctx, deps) {
    const plan = await deps.prisma.appearancePlan.findUnique({
      where: { id: input.planId },
      include: { stages: { orderBy: { stageIndex: "asc" } } },
    });
    if (!plan) return { status: "failed", error: `找不到方案 ${input.planId}` };
    if (plan.stages.length !== 4) return { status: "failed", error: `方案应有 4 个阶段，实际 ${plan.stages.length} 个` };

    const weights = input.weights ?? DEFAULT_WEIGHTS;
    const maxCore = input.maxCorePerStage ?? 3;
    const taskKeys = new Map(
      input.tasks.map((task, index) => [task, String(index)]),
    );
    const scoring = await deps.providers.planMaterialization.scoreTasks({
      tasks: input.tasks.map((task, index) => ({
        key: String(index),
        dimensions: task.dimensions,
      })),
      weights,
    });

    /**
     * 幂等性：先清掉待办任务，再重建。
     *
     * 这不是可选的整洁——本 step 被 `runWithSingleRetry` 包着，
     * **一次中途失败后的重试就会把任务插两遍**；重新落地方案（用户改了领域选择）
     * 同样会重复。实测过：重跑一次后阶段 0 从 4 个任务变 8 个，
     * 同一个方法同时以 core 和 optional 各出现一次。
     *
     * 只删 `pending`：`done`/`skipped`/`replaced` 承载**用户已经做过的事**，
     * 删掉等于抹掉进度，还会断开 `ChangeManifestEntry.sourceTaskId` 的追溯链。
     * 保留下来的任务在重建时按 (stageId, domain, title) 跳过，避免与新建的重复。
     */
    const stageIds = plan.stages.map((s) => s.id);
    await deps.prisma.stageTask.deleteMany({ where: { stageId: { in: stageIds }, status: "pending" } });
    const preserved = await deps.prisma.stageTask.findMany({
      where: { stageId: { in: stageIds } },
      select: { stageId: true, domain: true, title: true, priority: true },
    });
    const preservedKeys = new Set(preserved.map((t) => `${t.stageId}|${t.domain}|${t.title}`));
    // 保留任务里已经是 core 的，要计入该阶段的 core 名额，否则「每阶段最多 maxCore
    // 个 core」这条不变式会被破坏（保留的 core + 新建的 maxCore 个）
    const preservedCoreByStage = new Map<string, number>();
    for (const t of preserved) {
      if (t.priority === "core") preservedCoreByStage.set(t.stageId, (preservedCoreByStage.get(t.stageId) ?? 0) + 1);
    }

    // ── 步骤 1：按 applicableStageRange 确定性落位（不看打分）──
    const buckets: MaterializeTaskSpec[][] = [[], [], [], []];
    for (const t of input.tasks) {
      buckets[stageIndexFromRange(t.applicableStageRange)].push(t);
    }

    const summary: MaterializePlanOutput["stages"] = [];
    let totalTasks = 0;

    for (const [stageIndex, specs] of buckets.entries()) {
      const stage = plan.stages[stageIndex];

      // ── 步骤 2：阶段内用加权公式排序，决定 core/optional ──
      const scored = specs
        .map((s) => ({
          spec: s,
          score:
            scoring.scores[taskKeys.get(s)!] ??
            Number.NEGATIVE_INFINITY,
        }))
        .sort((a, b) => b.score - a.score);

      let coreAssigned = preservedCoreByStage.get(stage.id) ?? 0;
      for (const [order, { spec, score }] of scored.entries()) {
        // 已有同名任务（用户已完成/跳过的）不再重建，否则清单里会出现两条一样的。
        // ⚠ 这一步必须在 core 判定**之前**：否则一个在库里本是 optional 的保留任务
        // 会先占掉一个 core 名额再被跳过，白占额度。
        if (preservedKeys.has(`${stage.id}|${spec.domain}|${spec.title}`)) {
          totalTasks += 1; // 它确实是本方案的一项任务，计入总数
          continue;
        }

        // evidence_basis 是**打分前的硬性门槛**：general_best_practice 无论分多高
        // 都只能是 optional（无法从照片或问卷验证的通用建议，不该被包装成个性化诊断）
        const eligibleForCore = spec.evidenceBasis !== "general_best_practice" && Number.isFinite(score);
        const isCore = eligibleForCore && coreAssigned < maxCore;
        if (isCore) coreAssigned += 1;

        const isGuided = Boolean(spec.candidateOptions && spec.candidateOptions.length > 0);

        await deps.prisma.stageTask.create({
          data: {
            stageId: stage.id,
            domain: spec.domain,
            priority: isCore ? "core" : "optional",
            evidenceBasis: spec.evidenceBasis,
            taskType: isGuided ? "guided_selection" : "simple",
            selectionStatus: isGuided ? "pending_selection" : "not_applicable",
            candidateOptions: (spec.candidateOptions ?? undefined) as never,
            styleTag: spec.styleTag,
            title: spec.title,
            estTime: spec.estTime,
            estCost: spec.estCost,
            rationale: spec.rationale,
            changeDescription: spec.changeDescription,
            renderDescription: spec.renderDescription,
            sortOrder: order,
          },
        });
        totalTasks += 1;
      }

      await deps.prisma.stage.update({
        where: { id: stage.id },
        data: { windowLabel: STAGE_WINDOWS[stageIndex], status: stageIndex === 0 ? "active" : "locked" },
      });

      summary.push({
        stageIndex,
        windowLabel: STAGE_WINDOWS[stageIndex],
        taskCount: specs.length,
        coreCount: coreAssigned,
        // 决策 4：阶段0 不生成目标图——仪容清理类变化视觉差异极小，
        // 生成一张看不出区别的图除了浪费 ¥0.2 还制造"这就完了"的失望
        hasTargetImage: stageIndex > 0,
      });
    }

    return { status: "completed", data: { stages: summary, totalTasks } };
  },
};
