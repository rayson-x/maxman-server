/**
 * `CandidateTaskCatalog` 种子数据（foundation tasks 10.6）。
 *
 * 覆盖**非风格领域**：面部仪容 / 护肤 / 体态 / 健身 / 气味 / 口腔 / 其他。
 * 发型与穿搭由 `StyleProfileEntry` 接管（它们需要风格向量协调性，是另一套机制）。
 *
 * 来源：项目早期调研的男性形象改造方法目录（归档提案 decision 15 记录的 26 项 /
 * 8 领域）。其中明确标注「不建议纳入」的方法以 `isRecommended: false` 保留并写明
 * 排除原因——**保留而非删除**，是为了防止后续 LLM 或新同事把它们重新"发明"出来。
 *
 * 两条硬约束体现在数据里：
 *   - `applicableStageRange` 按**时间尺度**填（决策 7：阶段落位与打分无关）
 *   - `evidenceBasis` 为 `general_best_practice` 的条目永远只能是 optional
 *     （决策 7 的打分前硬门槛），这类是无法从照片或问卷验证的通用建议
 */

export type SeedCatalogEntry = {
  domain: string;
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
  /** 送往图生图的渲染文案。留空 = 正面照里画不出来，目标图不收 */
  renderDescription?: string;
};

export const CANDIDATE_TASK_CATALOG_SEED: SeedCatalogEntry[] = [
  // ── 面部仪容：视觉收益高、成本低、当天可做，是阶段0 的主力 ──
  {
    domain: "face_grooming",
    methodName: "剃净或修整胡须轮廓",
    description: "把杂乱的胡须剃净，或修出清晰的边界线（下颌线、颊线），让面部轮廓干净",
    evidenceBasis: "visual_detected",
    estTime: "10-15 分钟",
    estCostRange: "¥0（自备剃须刀）",
    reversibility: "full",
    riskLevel: "low",
    applicableStageRange: ["stage0"],
    visualBenefitLevel: "medium",
    isRecommended: true,
    renderDescription: "把胡须剃净，下颌线与颊线边界清晰"
  },
  {
    domain: "face_grooming",
    methodName: "修整眉形",
    description: "只清理眉毛边缘的杂毛与眉间连接处，不改变眉形本身——男性眉毛过度修饰会显刻意",
    evidenceBasis: "visual_detected",
    estTime: "10 分钟",
    estCostRange: "¥0-30",
    reversibility: "full",
    riskLevel: "low",
    riskNote: "修过头需要数周长回，第一次建议只清理眉间与边缘",
    applicableStageRange: ["stage0"],
    visualBenefitLevel: "medium",
    isRecommended: true,
    renderDescription: "眉毛边缘杂毛清理干净，眉形保持原样"
  },
  {
    domain: "face_grooming",
    methodName: "鼻毛与耳毛清理",
    description: "用专用修剪器清理外露的鼻毛耳毛。属于「不做会扣分、做了不加分」的项",
    evidenceBasis: "general_best_practice",
    estTime: "5 分钟",
    estCostRange: "¥30-80（修剪器一次性投入）",
    reversibility: "full",
    riskLevel: "low",
    applicableStageRange: ["stage0"],
    visualBenefitLevel: "low",
    isRecommended: true,
  },
  {
    domain: "face_grooming",
    methodName: "指甲清理与修剪",
    description: "剪短并清理指甲缝。近距离社交场景（递东西、握手）里这是高频被注意到的细节",
    evidenceBasis: "general_best_practice",
    estTime: "10 分钟",
    estCostRange: "¥0",
    reversibility: "full",
    riskLevel: "low",
    applicableStageRange: ["stage0"],
    visualBenefitLevel: "low",
    isRecommended: true,
  },

  // ── 护肤：见效需要周期，落阶段1-2 ──
  {
    domain: "skincare",
    methodName: "建立基础清洁+保湿流程",
    description: "早晚温和洁面 + 保湿。不追求复杂步骤，先把「洗干净、不干燥」做稳定",
    evidenceBasis: "visual_detected",
    estTime: "每天 5 分钟",
    estCostRange: "¥80-200/月",
    reversibility: "full",
    riskLevel: "low",
    applicableStageRange: ["stage1"],
    visualBenefitLevel: "medium",
    isRecommended: true,
  },
  {
    domain: "skincare",
    methodName: "日间防晒",
    description: "户外时段涂防晒。它对肤色均匀度与长期状态的影响大于任何护肤品，但短期看不出效果",
    evidenceBasis: "general_best_practice",
    estTime: "每天 2 分钟",
    estCostRange: "¥60-150/月",
    reversibility: "full",
    riskLevel: "low",
    applicableStageRange: ["stage1"],
    visualBenefitLevel: "low",
    isRecommended: true,
  },
  {
    domain: "skincare",
    methodName: "控油与出油管理",
    description: "针对 T 区明显出油：控油洁面 + 吸油纸/散粉应急，避免正午反光",
    evidenceBasis: "visual_detected",
    estTime: "每天 3 分钟",
    estCostRange: "¥50-120/月",
    reversibility: "full",
    riskLevel: "low",
    applicableStageRange: ["stage1"],
    visualBenefitLevel: "medium",
    isRecommended: true,
  },
  {
    domain: "skincare",
    methodName: "明显皮肤问题的专业咨询",
    description: "持续性痤疮、大面积泛红等情况建议咨询皮肤科，而不是自行叠加护肤品",
    evidenceBasis: "visual_detected",
    estTime: "视诊断而定",
    estCostRange: "视方案而定",
    reversibility: "partial",
    riskLevel: "medium",
    riskNote: "涉及医疗判断，产品本身不提供诊断或治疗方案",
    applicableStageRange: ["stage1"],
    visualBenefitLevel: "high",
    isRecommended: true,
  },

  // ── 体态：改善需要持续练习，落阶段2 ──
  {
    domain: "posture",
    methodName: "改善圆肩与头前倾",
    description: "针对久坐导致的圆肩、头前倾做拉伸与后背激活。体态对整体观感的影响常被低估——同一套衣服体态不同差别很大",
    evidenceBasis: "visual_detected",
    estTime: "每天 10 分钟",
    estCostRange: "¥0",
    reversibility: "full",
    riskLevel: "low",
    applicableStageRange: ["stage2"],
    visualBenefitLevel: "high",
    isRecommended: true,
  },
  {
    domain: "posture",
    methodName: "站姿与走姿的日常提醒",
    description: "刻意练习站立时重心居中、肩背打开。属于习惯养成，见效慢但零成本",
    evidenceBasis: "visual_detected",
    estTime: "日常留意",
    estCostRange: "¥0",
    reversibility: "full",
    riskLevel: "low",
    applicableStageRange: ["stage2"],
    visualBenefitLevel: "medium",
    isRecommended: true,
  },

  // ── 健身：见效周期最长，落阶段3 ──
  {
    domain: "fitness",
    methodName: "规律力量训练",
    description: "每周 2-3 次基础力量训练，重点是肩背——它决定了衣服的支撑感与整体比例",
    evidenceBasis: "self_reported",
    estTime: "每周 3-4 小时",
    estCostRange: "¥0-300/月",
    reversibility: "full",
    riskLevel: "medium",
    riskNote: "动作不标准可能受伤，起步阶段建议有人指导",
    applicableStageRange: ["stage3"],
    visualBenefitLevel: "high",
    isRecommended: true,
  },
  {
    domain: "fitness",
    methodName: "温和的饮食结构调整",
    description: "调整主食与蛋白比例、减少含糖饮料。刻意不做激进热量缺口方案",
    evidenceBasis: "self_reported",
    estTime: "日常",
    estCostRange: "¥0（可能反而省钱）",
    reversibility: "full",
    riskLevel: "medium",
    riskNote: "不提供极端减重方案；出现进食失调倾向时应停止并寻求专业帮助",
    applicableStageRange: ["stage3"],
    visualBenefitLevel: "high",
    isRecommended: true,
  },
  {
    domain: "fitness",
    methodName: "增加日常活动量",
    description: "通电话时走动、多走楼梯这类低门槛调整。对完全不运动的人来说，它的启动成本远低于办健身卡",
    evidenceBasis: "self_reported",
    estTime: "日常",
    estCostRange: "¥0",
    reversibility: "full",
    riskLevel: "low",
    applicableStageRange: ["stage2", "stage3"],
    visualBenefitLevel: "low",
    isRecommended: true,
  },

  // ── 气味：无法从照片验证，只能是 general_best_practice ──
  {
    domain: "body_odor",
    methodName: "使用止汗露或体香剂",
    description: "腋下止汗露。属于近距离社交里「有问题会致命、没问题不加分」的项",
    evidenceBasis: "general_best_practice",
    estTime: "每天 1 分钟",
    estCostRange: "¥40-100",
    reversibility: "full",
    riskLevel: "low",
    applicableStageRange: ["stage0"],
    visualBenefitLevel: "low",
    isRecommended: true,
  },
  {
    domain: "body_odor",
    methodName: "衣物与鞋袜的气味管理",
    description: "勤换洗、鞋子轮换晾晒。气味问题里衣物和鞋的占比常被忽略",
    evidenceBasis: "general_best_practice",
    estTime: "日常",
    estCostRange: "¥0-50",
    reversibility: "full",
    riskLevel: "low",
    applicableStageRange: ["stage0", "stage1"],
    visualBenefitLevel: "low",
    isRecommended: true,
  },
  {
    domain: "body_odor",
    methodName: "入门香水的克制使用",
    description: "若有兴趣可尝试淡香，一次 1-2 喷。用量过大在密闭空间是负分项",
    evidenceBasis: "general_best_practice",
    estTime: "每次 10 秒",
    estCostRange: "¥150-400",
    reversibility: "full",
    riskLevel: "low",
    riskNote: "过量使用效果反而为负",
    applicableStageRange: ["stage1", "stage2"],
    visualBenefitLevel: "low",
    isRecommended: true,
  },

  // ── 口腔：正面照上基本看不出，只能自报或通用建议 ──
  {
    domain: "dental",
    methodName: "口气管理",
    description: "刷牙时清理舌面、使用牙线。这项在近距离交流里权重很高，但完全无法从照片判断",
    evidenceBasis: "general_best_practice",
    estTime: "每天 5 分钟",
    estCostRange: "¥30-80/月",
    reversibility: "full",
    riskLevel: "low",
    applicableStageRange: ["stage0"],
    visualBenefitLevel: "low",
    isRecommended: true,
  },
  {
    domain: "dental",
    methodName: "洁牙（洗牙）",
    description: "去除牙结石与色渍。笑起来的观感改善明显，且属于医疗机构的常规项目",
    evidenceBasis: "self_reported",
    estTime: "1 次约 40 分钟",
    estCostRange: "¥200-500",
    reversibility: "full",
    riskLevel: "low",
    applicableStageRange: ["stage1"],
    visualBenefitLevel: "medium",
    isRecommended: true,
  },
  {
    domain: "dental",
    methodName: "牙齿矫正的专业评估",
    description: "牙列不齐影响观感时，建议先做正畸评估而非自行判断方案",
    evidenceBasis: "self_reported",
    estTime: "评估 1 次，矫正 1-2 年",
    estCostRange: "¥10000+",
    reversibility: "irreversible",
    riskLevel: "medium",
    riskNote: "周期长、投入大，属于医疗行为；产品只做转介不做方案",
    applicableStageRange: ["stage3"],
    visualBenefitLevel: "high",
    isRecommended: true,
  },

  // ── 其他 ──
  {
    domain: "other",
    methodName: "眼镜框型更新",
    description: "镜框是面部占比最大的配饰。换一副适合脸型的框比很多护肤投入见效更快",
    evidenceBasis: "visual_detected",
    estTime: "1 次约 1 小时",
    estCostRange: "¥300-1500",
    reversibility: "full",
    riskLevel: "low",
    applicableStageRange: ["stage1"],
    visualBenefitLevel: "high",
    isRecommended: true,
  },
  {
    domain: "other",
    methodName: "改善睡眠规律",
    description: "稳定作息对黑眼圈、面部浮肿、皮肤状态的影响大于多数护肤品，但需要数周才看得出",
    evidenceBasis: "self_reported",
    estTime: "日常",
    estCostRange: "¥0",
    reversibility: "full",
    riskLevel: "low",
    applicableStageRange: ["stage2"],
    visualBenefitLevel: "medium",
    isRecommended: true,
  },

  // ── 明确排除的方法：保留记录以防被重新"发明"出来 ──
  {
    domain: "face_grooming",
    methodName: "Mewing（舌抵上颚训练）",
    description: "宣称通过舌头位置训练改变颌面骨骼结构",
    evidenceBasis: "general_best_practice",
    estTime: "-",
    estCostRange: "¥0",
    reversibility: "full",
    riskLevel: "medium",
    applicableStageRange: [],
    visualBenefitLevel: "low",
    isRecommended: false,
    exclusionReason:
      "缺乏可靠证据支持其改变成年人颌面骨骼的效果宣称。社交平台传播广泛，正因如此必须显式排除——否则很容易被重新加回推荐列表",
  },
  {
    domain: "face_grooming",
    methodName: "下颌线训练器",
    description: "宣称通过咬合器械训练强化下颌线条",
    evidenceBasis: "general_best_practice",
    estTime: "-",
    estCostRange: "¥50-300",
    reversibility: "full",
    riskLevel: "medium",
    riskNote: "过度咬合训练可能引发颞下颌关节不适",
    applicableStageRange: [],
    visualBenefitLevel: "low",
    isRecommended: false,
    exclusionReason: "效果宣称缺乏证据支持，且存在颞下颌关节负担风险。调研阶段已标注不建议纳入",
  },
  {
    domain: "face_grooming",
    methodName: "面部瑜伽 / 面部肌肉操",
    description: "宣称通过面部肌肉训练达到提升轮廓的效果",
    evidenceBasis: "general_best_practice",
    estTime: "-",
    estCostRange: "¥0",
    reversibility: "full",
    riskLevel: "low",
    applicableStageRange: [],
    visualBenefitLevel: "low",
    isRecommended: false,
    exclusionReason: "现有证据不足以支持其对面部轮廓的可见改善；投入的时间用在体态或发型上收益明确得多",
  },
];

/** 供推荐引擎使用：只取被推荐的条目，可按领域过滤 */
export function getRecommendedSeedEntries(domain?: string): SeedCatalogEntry[] {
  return CANDIDATE_TASK_CATALOG_SEED.filter((e) => e.isRecommended && (!domain || e.domain === domain));
}
