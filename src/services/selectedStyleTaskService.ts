import type { MaterializeTaskSpec } from "../steps/materializePlan.js";
import { findObjectiveHairstyleAttributes } from "../features/appearance-agent/data/objectiveHairstyleAttributes.js";

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
      changeDescription: `已按选定方向调整发型：${input.hairstyle.nameZh}`,
      // 发型用属性表里的规范渲染描述，表外（用户自报）才退回目录描述
      renderDescription:
        findObjectiveHairstyleAttributes(input.hairstyle.nameZh)?.renderDescription
        ?? `把发型改成${input.hairstyle.nameZh}`,
      rationale: input.hairstyle.description,
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
