import type { Step } from "./types.js";
import type { AnalyzeVisionOutput } from "./analyzeVision.js";
import { computeHairConstraint, applyHairConstraint, type HairConstraint } from "../features/appearance-agent/rules/hairConstraints.js";
import {
  checkCompatibility,
  weightedAppeal,
  appealGap,
  isGapWorthDisclosing,
  DEFAULT_COMPATIBILITY_THRESHOLD,
  type StyleVector,
  type DualAppeal,
} from "../features/appearance-agent/data/styleProfile.js";

/**
 * S3 推荐（tasks 5.3/5.4/5.5）。
 *
 * 这一步的全部要点是**职责边界**（design.md 决策 2）：
 *
 *   确定性计算负责  →  谁有资格进候选（适配过滤 + 风格向量协调性 + 发型约束）
 *   LLM 负责        →  从已保证合规的候选里挑几个 + 写解释文案
 *
 * LLM 绝不判断"什么和什么搭"——审美协调性是它最不可靠的判断类型。
 * 也绝不产出最终排名（决策 6）：排序是后端固定加权公式的职责。
 */

type StyleEntryRow = {
  id: string;
  kind: string;
  nameZh: string;
  formality: number;
  maturity: number;
  boldness: number;
  upkeep: number;
  femaleAppealScore: number;
  femaleAppealSource: string;
  femaleAppealConfidence: string;
  femaleAppealRationale: string;
  maleSelfAppealScore: number;
  maleSelfAppealSource: string;
  maleSelfAppealConfidence: string;
  maleSelfAppealRationale: string;
  requiresHairVolume: "low" | "medium" | "high" | null;
  coversForehead: boolean | null;
  suitableFaceShapes: string[];
  suitableBodyTypes: string[];
  suitableScenes: string[];
  isRecommended: boolean;
};

function toVector(r: StyleEntryRow): StyleVector {
  return { formality: r.formality, maturity: r.maturity, boldness: r.boldness, upkeep: r.upkeep };
}

function toAppeal(r: StyleEntryRow): DualAppeal {
  return {
    femaleAppeal: {
      score: r.femaleAppealScore,
      source: r.femaleAppealSource,
      confidence: r.femaleAppealConfidence as "high" | "medium" | "low",
      rationale: r.femaleAppealRationale,
    },
    maleSelfAppeal: {
      score: r.maleSelfAppealScore,
      source: r.maleSelfAppealSource,
      confidence: r.maleSelfAppealConfidence as "high" | "medium" | "low",
      rationale: r.maleSelfAppealRationale,
    },
  };
}

export type RecommendInput = {
  vision: AnalyzeVisionOutput;
  /** 用户自由表达的意向（已过 S1 审核）。无意向时为 undefined */
  userPreferenceText?: string;
  /** 意向归一化到的目录 tag；null 表示未命中，需标注为"用户指定方向" */
  userPreferenceStyleTag?: string | null;
  /** 想要几个发型候选。默认 3（受并发=1 的吞吐天花板约束，见决策 12） */
  hairstyleCandidateCount?: number;
};

export type ScoredCandidate = {
  entryId: string;
  nameZh: string;
  /** 双审美评分与落差 —— 落差本身是产品要呈现给用户的核心信息 */
  femaleAppealScore: number;
  maleSelfAppealScore: number;
  appealGap: number;
  gapWorthDisclosing: boolean;
  /** 按用户目标加权后的分，用于排序 */
  weightedScore: number;
  rationale: string;
};

export type RecommendOutput = {
  hairConstraint: HairConstraint;
  /** 确定性过滤的审计轨迹——为什么某个候选没出现，要能解释给用户 */
  filterTrace: {
    totalHairstyles: number;
    afterFaceShapeFilter: number;
    afterHairConstraint: number;
    excludedByHairConstraint: { id: string; reason: string }[];
  };
  hairstyleCandidates: ScoredCandidate[];
  /** 用户意向的评估结果。无意向时为 null */
  userPreferenceAssessment: {
    styleTag: string | null;
    labelAsUserSpecified: boolean;
    inCatalog: boolean;
    /** 命中目录时给出它的双审美落差，让用户看到"你想要的 vs 数据怎么说" */
    appealGapVsRecommended?: number;
    note: string;
  } | null;
  /** 数据未就绪时明确说明，而不是返回空数组假装"没有合适的" */
  dataReady: boolean;
};

export const recommendStep: Step<RecommendInput, RecommendOutput> = {
  name: "S3_recommend",
  async run(input, ctx, deps) {
    const profile = await deps.prisma.appearanceProfile.findUnique({ where: { userId: ctx.userId } });
    const plan = ctx.planId ? await deps.prisma.appearancePlan.findUnique({ where: { id: ctx.planId } }) : null;
    const femaleWeight = plan?.femaleAppealWeight ?? 0.5;

    const allHairstyles = (await deps.prisma.styleProfileEntry.findMany({
      where: { kind: "hairstyle", isRecommended: true },
    })) as unknown as StyleEntryRow[];

    // 风格数据由调研任务产出（tasks 0.4），未就绪时**明确说明**而不是返回空数组——
    // 空数组会被下游误读成"这个用户没有合适的发型"
    if (allHairstyles.length === 0) {
      const hairConstraint = computeHairConstraint(input.vision.hairSignals);
      return {
        status: "completed_partial",
        data: {
          hairConstraint,
          filterTrace: { totalHairstyles: 0, afterFaceShapeFilter: 0, afterHairConstraint: 0, excludedByHairConstraint: [] },
          hairstyleCandidates: [],
          userPreferenceAssessment: null,
          dataReady: false,
        },
        missing: [{ item: "风格数据（StyleProfileEntry）", reason: "调研任务尚未交付（tasks 0.4），无候选可推荐" }],
      };
    }

    // ── 第一层确定性过滤：脸型适配 ──
    const faceShape = input.vision.geometry.faceShape ?? profile?.confirmedFaceShape ?? null;
    const afterFaceShape = faceShape
      ? allHairstyles.filter((h) => h.suitableFaceShapes.length === 0 || h.suitableFaceShapes.includes(faceShape))
      : allHairstyles;

    // ── 第二层确定性过滤：发际线/发量组合规则（第 6 节）──
    const hairConstraint = computeHairConstraint(input.vision.hairSignals);
    const filterable = afterFaceShape
      .filter((h) => h.requiresHairVolume !== null && h.coversForehead !== null)
      .map((h) => ({ id: h.id, requiresHairVolume: h.requiresHairVolume!, coversForehead: h.coversForehead! }));
    const { kept, excluded } = applyHairConstraint(filterable, hairConstraint);
    const keptIds = new Set(kept.map((k) => k.id));
    const eligible = afterFaceShape.filter((h) => keptIds.has(h.id));

    // ── 打分与排序：固定加权公式，不是 LLM 排的（决策 6）──
    const scored: ScoredCandidate[] = eligible
      .map((h) => {
        const appeal = toAppeal(h);
        return {
          entryId: h.id,
          nameZh: h.nameZh,
          femaleAppealScore: appeal.femaleAppeal.score,
          maleSelfAppealScore: appeal.maleSelfAppeal.score,
          appealGap: appealGap(appeal),
          gapWorthDisclosing: isGapWorthDisclosing(appeal),
          weightedScore: weightedAppeal(appeal, femaleWeight),
          rationale: appeal.femaleAppeal.rationale,
        };
      })
      .sort((a, b) => b.weightedScore - a.weightedScore)
      .slice(0, input.hairstyleCandidateCount ?? 3);

    // ── 用户意向评估 ──
    let userPreferenceAssessment: RecommendOutput["userPreferenceAssessment"] = null;
    if (input.userPreferenceText) {
      const tag = input.userPreferenceStyleTag ?? null;
      const matched = tag ? allHairstyles.find((h) => h.nameZh === tag) : undefined;
      userPreferenceAssessment = {
        styleTag: tag,
        labelAsUserSpecified: tag === null,
        inCatalog: Boolean(matched),
        appealGapVsRecommended: matched ? appealGap(toAppeal(matched)) : undefined,
        note: matched
          ? "你指定的方向在我们的推荐库内，已连同其审美评分一起返回，可与我们的推荐对比。"
          : "你指定的方向不在我们的推荐库内。可以照你说的生成效果图，但会标注为「你指定的方向」，效果仅供参考。",
      };
    }

    return {
      status: "completed",
      data: {
        hairConstraint,
        filterTrace: {
          totalHairstyles: allHairstyles.length,
          afterFaceShapeFilter: afterFaceShape.length,
          afterHairConstraint: eligible.length,
          excludedByHairConstraint: excluded.map((e) => ({ id: e.item.id, reason: e.reason })),
        },
        hairstyleCandidates: scored,
        userPreferenceAssessment,
        dataReady: true,
      },
    };
  },
};

/** 供测试与调用方复用的兼容组合判定，口径与 S3 内部一致 */
export function areCompatible(a: StyleVector, b: StyleVector): boolean {
  return checkCompatibility(a, b, DEFAULT_COMPATIBILITY_THRESHOLD).compatible;
}
