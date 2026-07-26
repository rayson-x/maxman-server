/**
 * Human-curated seed data (CandidateTaskCatalog（见 prisma/schema.prisma），
 * design.md decision 15) — TextPlanningProvider selects and scores ONLY from
 * entries here (filtered to isRecommended=true before the model ever sees
 * them); it must never invent a method outside this list. Starter coverage:
 * hair + outfit_accessory domains only, per current scope. The full 26-method
 * / 8-domain catalog (tasks.md 7.5a) is separate content work, not required
 * to validate the mechanism.
 */
export interface CandidateTaskCatalogEntry {
  id: string;
  domain: "hair" | "outfit_accessory";
  methodName: string;
  description: string;
  evidenceBasis: "visual_detected" | "self_reported" | "general_best_practice";
  estTime: string;
  estCostRange: string;
  reversibility: "full" | "partial" | "irreversible";
  riskLevel: "low" | "medium" | "high";
  riskNote?: string;
  applicableStageRange: string[];
  visualBenefitLevel: "low" | "medium" | "high";
  isRecommended: boolean;
  exclusionReason?: string;
}

export const CANDIDATE_TASK_CATALOG: CandidateTaskCatalogEntry[] = [
  {
    id: "hair-01",
    domain: "hair",
    methodName: "按脸型定制的理发/换发型",
    description: "根据脸型和发量特点，选择更修饰脸型比例的发型（如圆脸增加顶部高度、方脸软化轮廓线条）",
    evidenceBasis: "visual_detected",
    estTime: "1次理发，约1小时",
    estCostRange: "¥50-300",
    reversibility: "partial",
    riskLevel: "low",
    applicableStageRange: ["stage0", "stage1"],
    visualBenefitLevel: "high",
    isRecommended: true,
  },
  {
    id: "hair-02",
    domain: "hair",
    methodName: "染发调整发色",
    description: "调整发色使其更贴合肤色/风格定位（如偏黄皮避免过冷色调）",
    evidenceBasis: "visual_detected",
    estTime: "1次染发，约2-3小时",
    estCostRange: "¥200-800",
    reversibility: "partial",
    riskLevel: "medium",
    riskNote: "反复染发可能损伤发质，需控制频率",
    applicableStageRange: ["stage1", "stage2"],
    visualBenefitLevel: "medium",
    isRecommended: true,
  },
  {
    id: "hair-03",
    domain: "hair",
    methodName: "日常护发（护发素/发膜）",
    description: "针对发质干枯毛躁问题，建立规律护发习惯，改善发丝光泽和顺滑度",
    evidenceBasis: "visual_detected",
    estTime: "每周2-3次，每次10分钟",
    estCostRange: "¥50-150/月",
    reversibility: "full",
    riskLevel: "low",
    applicableStageRange: ["stage0", "stage1", "stage2", "stage3"],
    visualBenefitLevel: "low",
    isRecommended: true,
  },
  {
    id: "hair-04",
    domain: "hair",
    methodName: "脱发/发际线问题专业咨询",
    description: "存在脱发困扰但无法仅凭照片确诊时，建议咨询皮肤科/植发专业机构评估",
    evidenceBasis: "self_reported",
    estTime: "视诊断结果而定",
    estCostRange: "视方案而定，差异大",
    reversibility: "irreversible",
    riskLevel: "high",
    riskNote: "涉及医疗行为，产品本身不提供诊断或治疗方案",
    applicableStageRange: ["stage0"],
    visualBenefitLevel: "medium",
    isRecommended: true,
  },
  {
    id: "hair-05",
    domain: "hair",
    methodName: "下颌线训练器",
    description: "宣称通过咬合训练器改变下颌线条",
    evidenceBasis: "general_best_practice",
    estTime: "-",
    estCostRange: "-",
    reversibility: "full",
    riskLevel: "medium",
    applicableStageRange: [],
    visualBenefitLevel: "low",
    isRecommended: false,
    exclusionReason: "缺乏可靠证据支持其改变骨骼轮廓的效果宣称，可能误导用户，调研阶段已标注不建议纳入",
  },
  {
    id: "outfit-01",
    domain: "outfit_accessory",
    methodName: "基础合身度调整",
    description: "现有衣物送修改改肩宽/裤长/腰围等尺寸问题，是最低成本提升穿搭观感的方式",
    evidenceBasis: "visual_detected",
    estTime: "送改约3-5天",
    estCostRange: "¥30-100/件",
    reversibility: "partial",
    riskLevel: "low",
    applicableStageRange: ["stage0", "stage1"],
    visualBenefitLevel: "high",
    isRecommended: true,
  },
  {
    id: "outfit-02",
    domain: "outfit_accessory",
    methodName: "补充基础百搭单品",
    description: "针对衣橱缺口，补充少量高利用率的基础单品（如合身白衬衫/深色长裤），先解决'有没有'再谈风格",
    evidenceBasis: "self_reported",
    estTime: "视采购渠道而定",
    estCostRange: "¥200-600",
    reversibility: "full",
    riskLevel: "low",
    applicableStageRange: ["stage1", "stage2"],
    visualBenefitLevel: "medium",
    isRecommended: true,
  },
  {
    id: "outfit-03",
    domain: "outfit_accessory",
    methodName: "肤色适配的色彩搭配建议",
    description: "根据肤色冷暖倾向，建议更适配的服装主色调，减少显黑/显黄问题",
    evidenceBasis: "visual_detected",
    estTime: "-",
    estCostRange: "¥0（建议性）",
    reversibility: "full",
    riskLevel: "low",
    applicableStageRange: ["stage1", "stage2", "stage3"],
    visualBenefitLevel: "medium",
    isRecommended: true,
  },
  {
    id: "outfit-04",
    domain: "outfit_accessory",
    methodName: "场合着装规范认知",
    description: "针对特定场合（如约会/正式场合）建立基础着装规范认知，避免明显不合场合的穿着",
    evidenceBasis: "self_reported",
    estTime: "-",
    estCostRange: "¥0（建议性）",
    reversibility: "full",
    riskLevel: "low",
    applicableStageRange: ["stage0", "stage1"],
    visualBenefitLevel: "low",
    isRecommended: true,
  },
];

export function getRecommendedCatalogEntries(domain?: "hair" | "outfit_accessory"): CandidateTaskCatalogEntry[] {
  return CANDIDATE_TASK_CATALOG.filter((e) => e.isRecommended && (!domain || e.domain === domain));
}
