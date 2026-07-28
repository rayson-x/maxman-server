import type { AvailableVolumePremise, HairSignals, HairVolumeRequirement } from "../../rules/hairConstraints.js";

/**
 * 方案推荐能力的统一接口。**这是一条刻意设计的接缝**：
 * 背后的实现可以从"多模态 LLM 直接看图推荐"换成"确定性审美匹配引擎"，
 * 上游（S3 → S4 → select-style → S5）一行不改。
 *
 * 为什么现在需要这条接缝：审美匹配依赖的数据还不存在
 * （`StyleProfileEntry` 是空的，当前跑的是测试占位数据）。
 * 拿占位数据跑确定性匹配会输出**看起来有依据、实际没有**的结果——
 * 用户看到「系统为你的圆脸匹配了微碎盖」，而那条规则是编的。
 * 过渡期用 LLM 顶上并如实标注来源，比伪造依据诚实。
 *
 * ⚠ 字段的必填/可选是按「两种实现都能诚实产出」切的，不是按方便切的：
 *   必填 = 两种实现都给得出
 *   可选 = 只有目录匹配给得出，LLM **给不出且不许编**
 * 照着 LLM 能做的设计接口，将来匹配引擎装不进去；
 * 照着目录匹配设计，LLM 填不满。取交集是唯一不返工的做法。
 */

/** 推荐来源。决定给用户的措辞，不是记账字段 */
export type RecommendationSource =
  /** 多模态 LLM 看图产出 —— 只能对用户说「AI 建议」 */
  | "vision_llm"
  /** 确定性审美匹配 —— 才可以说「按风格数据匹配」 */
  | "catalog_matching";

export interface StyleRecommendationCandidate {
  /** 展示名。LLM 实现下可能是目录外的表述 */
  nameZh: string;
  description: string;
  /** 为什么推荐给这个用户。会展示给用户，不得含评判性或诊断性表述 */
  rationale: string;
  /** 交给图生图的变化指令。不含身份保留后缀，那由生成侧统一追加 */
  changeInstruction: string;
  /**
   * 来源决定面向用户的措辞：vision_llm 只能称为「AI 建议」，
   * catalog_matching 才能称为「按风格数据匹配」。丢掉它会把模型判断
   * 错误包装成有数据依据的结论，因此每条候选都必须携带。
   */
  source: RecommendationSource;
  /** 单条建议的可信度；视觉 LLM 过渡实现固定为 low。 */
  confidence: "low" | "medium" | "high";

  /**
   * 可行性标注 —— **必填**。
   * 这两个字段不是描述性信息，而是 `applyHairConstraint` 的输入：
   * 代码用它们机械校验推荐是否违反发量/发际线约束。
   * LLM 实现必须逐条标注，缺失的候选按「不可校验」剔除而非放行。
   */
  requiresHairVolume: HairVolumeRequirement;
  coversForehead: boolean;

  /**
   * 目录条目 id。LLM 实现下**落库之后**才有值——
   * `select-style` 要求 `styleProfileEntry.findUnique(entryId)` 命中，
   * 不落库则整条 onboarding 卡在 422。
   */
  entryId?: string;

  // ── 以下仅目录匹配实现能诚实给出 ──

  /** 风格向量四轴（1-10）。缺失时穿搭协调过滤不可用 */
  styleVector?: { formality: number; maturity: number; boldness: number; upkeep: number };
  /**
   * 双审美评分与落差。**LLM 实现必须留空**——
   * 这是要向用户展示为「从调研整理出的参考性先验」的东西，
   * 让模型编一组数字填进去，产出的是冒充调研结论的虚假信息。
   */
  appeal?: {
    femaleAppealScore: number;
    maleSelfAppealScore: number;
    appealGap: number;
    gapWorthDisclosing: boolean;
  };
}

/**
 * 筛选审计轨迹。只有确定性筛选才产生得出，
 * 所以结构保留、内容诚实标注是否可用。
 *
 * 刻意不删这个字段：删了将来加回去所有消费方都要改。
 * 也刻意不填假数据：填了就是伪造审计轨迹。
 */
export interface RecommendationFilterTrace {
  available: boolean;
  /** available=false 时说明为什么没有轨迹 */
  unavailableReason?: string;
  totalCandidates?: number;
  afterFaceShapeFilter?: number;
  afterHairConstraint?: number;
  excluded?: { entryId: string; nameZh: string; excludedBy: string; reason: string }[];
}

export interface RecommendationFeasibilitySummary {
  requestedCount: number;
  actualCount: number;
  /** 机械校验后距请求数量的缺口；不得通过放宽约束补齐。 */
  shortfall: number;
  constraintStrength: "strong" | "moderate" | "none" | "deferred";
  excluded: {
    nameZh: string;
    code:
      | "missing_feasibility_annotation"
      | "invalid_candidate"
      | "unknown_objective_attributes"
      | "hair_constraint_violation";
    reason: string;
  }[];
  /**
   * 模型对 requiresHairVolume 的标注本身可能有误；当前机械层只能阻断
   * 明显冲突，目录匹配到位后应由人工标注数据替代该模型标注。
   */
  residualRisk: string;
}

export interface StyleRecommendationInput {
  /** 头像的**短时预签名** URL。签发即落 PhotoAccessLog，不新开取图路径 */
  photoReadUrl: string;
  domain: "hairstyle" | "outfit";
  requestedCount: number;

  /** 客户端 478 点几何的结论。决策 5：这是脸型的权威来源，服务端不重新判断 */
  geometry: {
    faceShape: string | null;
    confidence: string | null;
    evidence: Record<string, number>;
  };
  /** 发际线/发量信号，供可行性约束使用 */
  hairSignals: HairSignals;
  /**
   * 可用发量前提。缺省 `own_hair`。
   *
   * provider **不知道「假发」这个概念**——它只知道前提。传 `ample` 时它看到的是
   * 「可用发量充足」，于是给出的适配理由在其所处前提下是真话；如果让它同时看到
   * 「发量偏少」和一批高发量需求候选，它只能自相矛盾或编造。
   */
  premise?: AvailableVolumePremise;

  /** 问卷画像。决策 11：身体数据是推荐输入，不是图像生成输入 */
  profile: {
    heightCm?: number | null;
    weightKg?: number | null;
    bodyFatPercent?: number | null;
    exercisesRegularly?: boolean | null;
    wearsGlasses?: boolean | null;
    hasBeard?: boolean | null;
    selfReportedHairVolume?: string | null;
    hairLossConcern?: boolean;
    budgetTier?: string | null;
  };

  /** 已过两层审核的用户意向；未命中目录 tag 时 styleTag 为 null */
  preference?: { text: string; styleTag: string | null } | null;

  /** S2 的结构化语义分析（发型/发际线可见性/胡须/眼镜/肤色/当前穿着） */
  semantics?: Record<string, unknown> | null;
}

export interface StyleRecommendationResult {
  provider: string;
  source: RecommendationSource;
  /** 对这批推荐整体的可信度自评，用于决定措辞强度 */
  confidence: "low" | "medium" | "high";
  candidates: StyleRecommendationCandidate[];
  /**
   * 只有目录匹配能提供完整审美筛选轨迹。视觉 LLM 会显式返回
   * available=false；其他未来实现也可以完全省略，上游不得臆造。
   */
  filterTrace?: RecommendationFilterTrace;
  feasibility: RecommendationFeasibilitySummary;
  /** 本实现给不出的能力，如实列出供上游标记（双审美评分、协调过滤等） */
  unavailableCapabilities: { capability: string; reason: string }[];
  latencyMs: number;
  /** 供应商调用 id，用于成本追溯 */
  callId?: string;
}

export interface StyleRecommendationProvider {
  readonly name: string;
  readonly source: RecommendationSource;
  recommend(input: StyleRecommendationInput): Promise<StyleRecommendationResult>;
}
