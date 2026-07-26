/**
 * 把 `CandidateTaskCatalog` 的字段映射成 S5 打分需要的七个维度。
 *
 * 为什么必须有这一层：`MaterializeTaskSpec.dimensions` 缺省时任务**直接判为
 * optional**，不参与 core 竞争。实测后果比"少个字段"严重得多——四个阶段
 * `coreCount` 全为 0，而 `unlockRule` 是「完成所有 core 任务才解锁」，
 * core 为 0 时该条件**空真**，四个阶段立刻全部解锁，分阶段推进机制整体失效。
 *
 * 映射原则：**只从目录已有字段推导，不编造事实**。
 *   visualBenefit ← visualBenefitLevel
 *   credibility   ← evidenceBasis（决策 6 的证据分级，同一套口径）
 *   acceptance    ← 用户问卷里的 domainAcceptance（真实用户意愿，不是我们猜的）
 *   reversibility ← reversibility
 *   timeCost      ← estTime 解析
 *   moneyCost     ← estCostRange 解析
 *   risk          ← riskLevel
 *
 * ⚠ 各档位的**具体数值是初始校准，待产品校准**。它们只影响 core/optional 的
 * 切分与排序，不影响任何事实性判断；等有了真实用户完成率数据应当回来调。
 * 之所以现在就给一版而不是留空：留空等于让分阶段机制静默失效。
 */

export type TaskDimensions = {
  visualBenefit: number;
  credibility: number;
  acceptance: number;
  reversibility: number;
  timeCost: number;
  moneyCost: number;
  risk: number;
};

/** 视觉收益。high 给 9 而非 10：留出余量给未来更强的干预手段 */
const VISUAL_BENEFIT: Record<string, number> = { low: 3, medium: 6, high: 9 };

/**
 * 可信度沿用决策 6 的证据分级：
 * 视觉实测 > 用户自报 > 通用最佳实践。
 * `general_best_practice` 给 3 而不是 0——它不是不可信，只是缺少针对本人的证据。
 */
const CREDIBILITY: Record<string, number> = {
  visual_detected: 9,
  self_reported: 6,
  general_best_practice: 3,
};

/** 可逆性是收益项：越可逆越该优先做，因为试错成本低 */
const REVERSIBILITY: Record<string, number> = { full: 9, partial: 5, irreversible: 1 };

/** 风险是成本项，直接扣分 */
const RISK: Record<string, number> = { low: 1, medium: 5, high: 9 };

/**
 * 时间成本分档（分钟）。跨档取上界，宁可高估成本也不诱导用户低估投入。
 *
 * 分档：≤15min→1  ≤1h→3  ≤1天→5  ≤1周→7  更长→9
 * ⚠ 已知粒度偏粗：「2 小时」（去一次理发店）与「一整天」同为 5 分。
 * 暂不细分，因为再切一档缺乏数据支撑；等有真实完成率数据再校准。
 */
function parseTimeCost(estTime: string | null | undefined): number {
  if (!estTime) return 5; // 未标注时给中位，不假设它很轻松
  const nums = [...estTime.matchAll(/(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  const n = nums.length > 0 ? Math.max(...nums) : 1;
  // 单位换算成分钟。注意「周/月」必须先判，否则 "2-4 周" 会被当成 4 分钟
  let minutes = n;
  if (/月/.test(estTime)) minutes = n * 30 * 24 * 60;
  else if (/周/.test(estTime)) minutes = n * 7 * 24 * 60;
  else if (/天|日/.test(estTime)) minutes = n * 24 * 60;
  else if (/小时|时/.test(estTime)) minutes = n * 60;

  if (minutes <= 15) return 1;
  if (minutes <= 60) return 3;
  if (minutes <= 24 * 60) return 5;
  if (minutes <= 7 * 24 * 60) return 7;
  return 9;
}

/** 金钱成本分档（元）。同样取区间上界 */
function parseMoneyCost(estCost: string | null | undefined): number {
  if (!estCost) return 5;
  const nums = [...estCost.matchAll(/(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  if (nums.length === 0) return 5;
  const yuan = Math.max(...nums);
  if (yuan <= 0) return 0;
  if (yuan <= 50) return 1;
  if (yuan <= 200) return 3;
  if (yuan <= 500) return 5;
  if (yuan <= 2000) return 7;
  return 9;
}

/**
 * 用户对该领域的接受度。来自问卷 `domainAcceptance`——**这是用户自己表达的意愿，
 * 不是我们替他猜的**，所以它在打分里权重与视觉收益等同是合理的。
 * 未表态时给中位 5，既不当作抗拒也不当作热情。
 */
function parseAcceptance(domainAcceptance: unknown, domain: string): number {
  if (!domainAcceptance || typeof domainAcceptance !== "object") return 5;
  const raw = (domainAcceptance as Record<string, unknown>)[domain];
  if (typeof raw === "number") return Math.max(0, Math.min(10, raw));
  if (typeof raw === "boolean") return raw ? 8 : 2;
  if (typeof raw === "string") {
    const m: Record<string, number> = { high: 9, medium: 5, low: 2, accepted: 8, rejected: 1 };
    return m[raw] ?? 5;
  }
  return 5;
}

export function deriveTaskDimensions(
  row: {
    domain: string;
    evidenceBasis: string;
    reversibility: string;
    riskLevel: string;
    visualBenefitLevel: string | null;
    estTime: string | null;
    estCostRange: string | null;
  },
  domainAcceptance: unknown,
): TaskDimensions {
  return {
    visualBenefit: VISUAL_BENEFIT[row.visualBenefitLevel ?? ""] ?? 5,
    credibility: CREDIBILITY[row.evidenceBasis] ?? 5,
    acceptance: parseAcceptance(domainAcceptance, row.domain),
    reversibility: REVERSIBILITY[row.reversibility] ?? 5,
    timeCost: parseTimeCost(row.estTime),
    moneyCost: parseMoneyCost(row.estCostRange),
    risk: RISK[row.riskLevel] ?? 5,
  };
}

/** 仅供测试导出，便于单独验证解析边界 */
export const __internals = { parseTimeCost, parseMoneyCost, parseAcceptance };
