import { z } from "zod";
import { ALL_DOMAINS } from "../features/appearance-agent/data/domains.js";

/**
 * 采集请求校验（tasks 3.3）。
 *
 * 决策 9：核心硬字段走表单——固定管道需要**确定的结构化输入**才能跑打分公式，
 * 用对话收这些字段会导致「问全了吗」的反向校验负担。
 */

export const basicQuestionnaireSchema = z.object({
  track: z.enum(["short_term", "long_term"]),
  birthDate: z.string().datetime().optional(),
  ageConfirmed18Plus: z.boolean(),
});

export const fullQuestionnaireSchema = z.object({
  heightCm: z.number().int().min(120).max(230).optional(),
  weightKg: z.number().min(30).max(200).optional(),
  /** 可选细项：填了能让穿搭推荐更准（决策 11：身体数据是推荐输入，不是生成输入） */
  shoulderWidthCm: z.number().min(20).max(80).optional(),
  chestCm: z.number().min(50).max(180).optional(),
  waistCm: z.number().min(40).max(180).optional(),
  thighCm: z.number().min(25).max(100).optional(),
  bodyFatPercent: z.number().min(3).max(60).optional(),
  exercisesRegularly: z.boolean().optional(),

  occupation: z.string().max(50).optional(),
  wearsGlasses: z.boolean().optional(),
  hasBeard: z.boolean().optional(),

  /** 决策 6：发量自报。云端视觉判断发量实测不可靠，自报在此用途上够用 */
  selfReportedHairVolume: z.enum(["thin", "medium", "thick"]).optional(),
  /** 决策 6：与视觉信号交叉验证，evidence_basis=self_reported */
  hairLossConcern: z.boolean().default(false),

  /**
   * 用权威词表约束，不接受任意字符串。原先是 `z.array(z.string())`，
   * 实测提交看起来合理的 `["hairstyle","outfit","grooming"]` 与目录里的
   * `face_grooming/skincare/...` 零重叠，S5 过滤后 0 个任务却报 completed——
   * 空方案伪装成成功。词表不匹配必须在入口就 422。
   */
  domainSelections: z.array(z.enum(ALL_DOMAINS)).min(1),
  domainAcceptance: z.record(z.string(), z.unknown()).optional(),
  budgetTier: z.enum(["low", "medium", "high"]),
});

export const faceShapeConfirmationSchema = z.object({
  /** 用户确认或修正后的脸型。决策 5：用户修正值优先于计算值 */
  confirmedFaceShape: z.enum(["oval", "round", "square", "oblong", "heart", "diamond", "pear"]),
});

/** tasks 3.8：发型意向 gate —— 显式二选一，选"有"才带 preference 文本 */
export const hairIntentSchema = z
  .object({
    hasPreference: z.boolean(),
    preferenceText: z.string().max(300).optional(),
  })
  .refine((v) => !v.hasPreference || (v.preferenceText?.trim().length ?? 0) > 0, {
    message: "hasPreference 为 true 时必须提供 preferenceText",
    path: ["preferenceText"],
  });

export const photoConsentSchema = z.object({
  consentType: z.enum(["terms", "face_processing", "training"]),
  version: z.string().min(1),
  /** 同意文本快照的引用（存证用），不存全文避免每次同意都复制一大段 */
  snapshotTextRef: z.string().optional(),
});

/**
 * 客户端 MediaPipe 测量结果的结构约定（决策 5：这是脸型的**权威来源**）。
 *
 * 为什么必须校验形状，而不是 `z.unknown()`：这是客户端↔服务端的契约边界，
 * 而两端由不同的人/agent 在写。原先不校验的后果实测过一次——用扁平结构
 * `{faceShape, confidence}` 提交，POST /photos 返回 200，但读取侧
 * （`getComputedFaceShape` 与 `analyzeVision` 都读 `classification.faceShape.value`）
 * 拿不到值，于是 `GET /face-shape/computed` 报「尚无可用的正面照测量数据」。
 * 写入成功 + 读取为空，最难查的一类错。宁可在入口 422 并说清期望结构。
 *
 * 字段一律可选（人脸检测可能部分失败，比如刘海遮挡时 hairline 判不出），
 * 但**取值用枚举约束**，让拼写错误立刻暴露而不是退化成默认值。
 */
export const faceMetricsSchema = z.object({
  classification: z.object({
    faceShape: z
      .object({
        value: z.enum(["oval", "round", "square", "oblong", "heart", "diamond", "pear"]),
        confidence: z.enum(["low", "medium", "high"]).optional(),
        /** 支撑比值，如 { widthToHeight: 0.92 }。决策 5：给用户确认时要能出示原始比值 */
        evidence: z.record(z.string(), z.number()).optional(),
      })
      .optional(),
    /** occluded 表示被刘海遮挡判不出，下游据此走云端兜底（决策 6） */
    hairline: z.object({ value: z.enum(["normal", "high", "receding", "occluded"]) }).optional(),
    hairVolume: z.object({ value: z.enum(["thin", "medium", "thick"]) }).optional(),
  }),
  /** 允许客户端附带原始 landmark、IPD 归一化参数等，服务端不解释 */
  raw: z.unknown().optional(),
});

export const photoRegistrationSchema = z.object({
  photoType: z.enum(["front", "side", "full_body", "progress"]),
  storageKey: z.string().min(1),
  faceMetrics: faceMetricsSchema.optional(),
});

export type BasicQuestionnaireInput = z.infer<typeof basicQuestionnaireSchema>;
export type FullQuestionnaireInput = z.infer<typeof fullQuestionnaireSchema>;
export type HairIntentInput = z.infer<typeof hairIntentSchema>;
