import type { MaterializeTaskSpec } from "../steps/materializePlan.js";
import { findObjectiveHairstyleAttributes } from "../features/appearance-agent/data/objectiveHairstyleAttributes.js";
import type { WigCraftTier } from "../features/appearance-agent/data/objectiveHairstyleAttributes.js";

/**
 * 把用户选定的发型与穿搭变成两条阶段任务。
 *
 * 选定项来自 `RecommendationCandidate`——候选可能由 Agent 直接产出、没有目录引用，
 * 因此这里**不依赖双审美评分**。
 *
 * 不提供 `dimensions`：那套七维打分需要经过校准的评分数据，当前没有。
 * 缺省 dimensions 的后果是这两条任务成为 optional 而非 core，这是刻意的——
 * 编造一组中性分值把「不可得」洗成「已评估」，比让它们排在后面有害得多。
 * 阶段解锁所需的 core 任务由方法目录那一侧提供。
 */

/** 选定的候选。字段取自 `RecommendationCandidate` 与其所属集合的 kind */
export type SelectedStyleRow = {
  kind: string;
  nameZh: string;
  description: string;
  /**
   * 达成路径。仅当这个款式是**靠补充发量才能达成**时才有值（见 rules/wigOptions）。
   *
   * 它进 `changeDescription` 与 `rationale`，**绝不进 `renderDescription`**：
   * 图该画的是「戴上之后长什么样」，而渲染文案是按图像供应商逐款校准的，混入
   * 未校准语义会产出网底、发根断层这类伪影。达成路径是元信息，不是图像内容。
   */
  achievement?: { tier: WigCraftTier; label: string };
};

export type SelectedStylesInput = {
  hairstyle: SelectedStyleRow | null;
  outfit: SelectedStyleRow | null;
};

export function buildSelectedStyleTaskSpecs(input: SelectedStylesInput): MaterializeTaskSpec[] {
  if (!input.hairstyle || !input.outfit) {
    throw new Error("落地方案需要同时选定发型与穿搭");
  }
  if (input.hairstyle.kind !== "hairstyle" || input.outfit.kind !== "outfit") {
    throw new Error("选定项的类型与方案字段不匹配");
  }

  return [
    {
      domain: "hairstyle",
      title: `落实选定发型：${input.hairstyle.nameZh}`,
      applicableStageRange: ["stage1"],
      // 用户自己选的方向，证据基础是自报而非视觉实测
      evidenceBasis: "self_reported",
      changeDescription: input.hairstyle.achievement
        ? `已按选定方向调整发型：${input.hairstyle.nameZh}（${input.hairstyle.achievement.label}）`
        : `已按选定方向调整发型：${input.hairstyle.nameZh}`,
      // 只有逐款校准过的发型才能进入图生图。表外候选仍可被用户选中并落为任务，
      // 但不能把未校验的名称拼成 prompt 后冒充「未来的你」效果。
      renderDescription:
        findObjectiveHairstyleAttributes(input.hairstyle.nameZh)?.renderDescription,
      rationale: input.hairstyle.achievement
        ? `${input.hairstyle.description}。${input.hairstyle.achievement.label}`
        : input.hairstyle.description,
    },
    {
      domain: "outfit",
      title: `落实选定穿搭：${input.outfit.nameZh}`,
      applicableStageRange: ["stage1"],
      evidenceBasis: "self_reported",
      changeDescription: `已按选定方向调整穿搭：${input.outfit.nameZh}`,
      renderDescription: `换成${input.outfit.nameZh}这套穿搭`,
      rationale: input.outfit.description,
    },
  ];
}
