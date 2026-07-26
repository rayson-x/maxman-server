/**
 * 改善领域的**权威词表**。
 *
 * 为什么需要它：原先 `domainSelections` 是 `z.array(z.string()).min(1)`，
 * 而 `CandidateTaskCatalog.domain` 是自由字符串，两边没有共同词表。实测后果——
 * 提交 `["hairstyle","outfit","grooming"]`（看起来完全合理）与目录里的
 * `face_grooming/skincare/...` 零重叠，S5 过滤后一个任务都不剩，
 * 却仍然报 `completed`，`totalTasks: 0`。**空结果伪装成成功**，
 * 而客户端会渲染出一份空方案。
 *
 * 词表按数据来源分成两类，这个区分不是分类洁癖——它决定了 S5 该不该管：
 *   - `CATALOG_DOMAINS`：方法目录（`CandidateTaskCatalog`）驱动，S5 从目录取任务
 *   - `STYLE_DOMAINS`：风格数据（`StyleProfileEntry`）驱动，走 S3/S4 的推荐+预览
 *     路径，**不在方法目录里**。若把它们一起丢给目录过滤，永远匹配不到，
 *     又会得到「选了发型却没有发型任务」的空结果。
 */

/** 由 CandidateTaskCatalog 提供任务的领域。取值必须与目录里实际使用的 domain 一致 */
export const CATALOG_DOMAINS = [
  "face_grooming",
  "skincare",
  "dental",
  "body_odor",
  "fitness",
  "posture",
  "other",
] as const;

/** 由 StyleProfileEntry 驱动的领域，经 S3 推荐 + S4 预览，不经方法目录 */
export const STYLE_DOMAINS = ["hairstyle", "outfit"] as const;

export const ALL_DOMAINS = [...STYLE_DOMAINS, ...CATALOG_DOMAINS] as const;

export type Domain = (typeof ALL_DOMAINS)[number];
export type CatalogDomain = (typeof CATALOG_DOMAINS)[number];

export function isCatalogDomain(d: string): d is CatalogDomain {
  return (CATALOG_DOMAINS as readonly string[]).includes(d);
}

export function isStyleDomain(d: string): boolean {
  return (STYLE_DOMAINS as readonly string[]).includes(d);
}

/** 给用户看的中文名。仅用于展示，判定一律用上面的英文 key */
export const DOMAIN_LABELS_ZH: Record<Domain, string> = {
  hairstyle: "发型",
  outfit: "穿搭",
  face_grooming: "面部仪容",
  skincare: "护肤",
  dental: "牙齿",
  body_odor: "体味",
  fitness: "健身塑形",
  posture: "体态",
  other: "其他",
};
