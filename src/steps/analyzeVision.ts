import { recordWorkflowRun, type Step } from "./types.js";
import { photoModerationWhere } from "../lib/photoModerationGate.js";
import type { HairSignals, HairlineSignal, VolumeSignal } from "../features/appearance-agent/rules/hairConstraints.js";
import { createPhotoAccessService } from "../services/photoAccessService.js";
import {
  applySemanticHairlineVisibility,
  parseSemanticAnalysis,
  type StructuredSemanticAnalysis,
} from "../features/appearance-agent/analysis/semanticAnalysis.js";

/**
 * S2 视觉分析（tasks 5.2）。
 *
 * 分工是这一步的全部要点（design.md 决策 5）：
 *   - **几何判断归客户端**：脸型、三庭五眼等由 MediaPipe 的确定性规则算出，
 *     已随照片上传落在 `UserPhoto.faceMetrics`。这一步只**读取**，不重新判断。
 *     实测云端 vision 对 face_shape 两家一致率仅 2/10，把几何交给语义模型是错的。
 *   - **语义判断归云端**：当前发型、胡须、眼镜、肤色、穿搭现状——这些是语义描述，
 *     模型擅长且没有确定性替代方案。
 */

export type AnalyzeVisionInput = {
  frontPhotoStorageKey: string;
  fullBodyPhotoStorageKey?: string;
};

export type AnalyzeVisionOutput = {
  /** 云端语义分析原文（结构化 JSON 字符串或自由文本，取决于 provider） */
  semanticAnalysis: string;
  /** 经过字段白名单、长度限制和枚举校验的语义结果，供后续确定性逻辑使用。 */
  structuredSemantic: StructuredSemanticAnalysis;
  provider: string;
  /** 从客户端 faceMetrics 读出的几何结论（不是云端判断的） */
  geometry: {
    faceShape: string | null;
    confidence: string | null;
    evidence: Record<string, number>;
    source: "client_mediapipe" | "unavailable";
  };
  /** 供第 6 节发型约束规则使用的信号 */
  hairSignals: HairSignals;
  hasFullBody: boolean;
};

const SEMANTIC_PROMPT =
  "请分析这张照片中人物的**语义特征**，只输出结构化JSON，不要输出JSON之外的文字。" +
  "字段：current_hairstyle(当前发型描述) / hairline_visibility(发际线是否被刘海遮挡，取值 visible|occluded) / " +
  "facial_hair(胡须状况) / glasses(是否戴眼镜及款式) / skin_tone(肤色冷暖倾向) / current_outfit(当前穿着描述)。" +
  "不要判断脸型或任何几何比例——那部分由客户端精确测量提供。不要做医学诊断，不要评判性描述。";

/** 从客户端 faceMetrics 里提取几何结论与发型信号。faceMetrics 缺失时优雅降级。 */
function extractFromFaceMetrics(faceMetrics: unknown): {
  geometry: AnalyzeVisionOutput["geometry"];
  hairline: HairlineSignal;
  volume: VolumeSignal;
} {
  const m = faceMetrics as
    | {
        classification?: {
          faceShape?: { value?: string; confidence?: string; evidence?: Record<string, number> };
          hairline?: { value?: string };
          hairVolume?: { value?: string };
        };
      }
    | null
    | undefined;

  const fs = m?.classification?.faceShape;
  const geometry: AnalyzeVisionOutput["geometry"] = fs?.value
    ? { faceShape: fs.value, confidence: fs.confidence ?? "low", evidence: fs.evidence ?? {}, source: "client_mediapipe" }
    : { faceShape: null, confidence: null, evidence: {}, source: "unavailable" };

  const rawHairline = m?.classification?.hairline?.value;
  const hairline: HairlineSignal =
    rawHairline === "receding" || rawHairline === "high" || rawHairline === "occluded" ? rawHairline : "normal";

  const rawVolume = m?.classification?.hairVolume?.value;
  const volume: VolumeSignal =
    rawVolume === "thin" || rawVolume === "medium" || rawVolume === "thick" ? rawVolume : "unknown";

  return { geometry, hairline, volume };
}

export const analyzeVisionStep: Step<AnalyzeVisionInput, AnalyzeVisionOutput> = {
  name: "S2_analyze_vision",
  async run(input, ctx, deps) {
    const photo = await deps.prisma.userPhoto.findFirst({
      where: {
        userId: ctx.userId,
        storageKey: input.frontPhotoStorageKey,
        deletionStatus: "active",
        ...photoModerationWhere(),
      },
    });
    if (!photo) {
      return {
        status: "failed",
        error: `找不到已通过审核的正面照记录: ${input.frontPhotoStorageKey}`,
      };
    }

    const { geometry, hairline, volume } = extractFromFaceMetrics(photo.faceMetrics);

    const profile = await deps.prisma.appearanceProfile.findUnique({ where: { userId: ctx.userId } });

    let hairSignals: HairSignals = {
      hairline,
      volume,
      selfReportedHairLossConcern: profile?.hairLossConcern ?? false,
      selfReportedVolume: profile?.selfReportedHairVolume ?? undefined,
    };

    // 给供应商的是**短时预签名 URL**，不是永久公开链接（tasks 1.5）。
    // 有效期只需覆盖单次调用。
    const { url: imageUrl } = await createPhotoAccessService(deps.prisma).issueReadUrl({
      storageKey: input.frontPhotoStorageKey,
      photoId: photo.id,
      accessorType: "system_provider",
      purpose: "视觉外观语义分析",
      expiresSeconds: 600,
    });

    let semanticAnalysis: string;
    let provider: string;
    try {
      const result = await deps.providers.vision.analyze({ imageUrl, prompt: SEMANTIC_PROMPT });
      semanticAnalysis = result.rawText;
      provider = result.provider;
      await recordWorkflowRun(deps.prisma, {
        jobId: ctx.jobId,
        planId: ctx.planId,
        stepName: "S2_analyze_vision_provider",
        finalStatus: "completed",
        latencyMs: result.latencyMs,
        provider: result.provider,
        modelVersion: result.model,
      });
    } catch (err) {
      // 语义分析失败不该让整步归零——几何数据来自客户端，本来就已经拿到了。
      // 降级为部分成功，下游仍可用几何 + 自报数据做过滤。
      return {
        status: "completed_partial",
        data: {
          semanticAnalysis: "",
          structuredSemantic: {},
          provider: "unavailable",
          geometry,
          hairSignals,
          hasFullBody: Boolean(input.fullBodyPhotoStorageKey),
        },
        missing: [{ item: "云端语义分析", reason: err instanceof Error ? err.message : String(err) }],
      };
    }

    const structuredSemantic = parseSemanticAnalysis(semanticAnalysis);
    hairSignals = applySemanticHairlineVisibility(hairSignals, structuredSemantic);

    // 用户确认过的脸型优先于计算值（决策 5）
    if (profile?.confirmedFaceShape) {
      geometry.faceShape = profile.confirmedFaceShape;
      geometry.confidence = "user_confirmed";
    }

    return {
      status: "completed",
      data: {
        semanticAnalysis,
        structuredSemantic,
        provider,
        geometry,
        hairSignals,
        hasFullBody: Boolean(input.fullBodyPhotoStorageKey),
      },
    };
  },
};
