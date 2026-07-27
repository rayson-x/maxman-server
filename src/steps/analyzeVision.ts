import type { Step } from "./types.js";
import { photoModerationWhere } from "../lib/photoModerationGate.js";
import type { HairSignals, HairlineSignal, VolumeSignal } from "../features/appearance-agent/rules/hairConstraints.js";

/**
 * 首轮多模态调用前的确定性输入准备。
 *
 * 分工是这一步的全部要点（design.md 决策 5）：
 *   - **几何判断归客户端**：脸型、三庭五眼等由 MediaPipe 的确定性规则算出，
 *     已随照片上传落在 `UserPhoto.faceMetrics`。这一步只**读取**，不重新判断。
 *     实测云端 vision 对 face_shape 两家一致率仅 2/10，把几何交给语义模型是错的。
 *   - 当前发型、胡须、眼镜、肤色、穿搭现状，以及面向用户的结论，统一由随后的
 *     单次多模态 tool call 产出。这里绝不再单独调用 vision provider，否则会重新
 *     引入 S2 + S3 的两次付费调用。
 */

export type AnalyzeVisionInput = {
  frontPhotoStorageKey: string;
  fullBodyPhotoStorageKey?: string;
};

export type AnalyzeVisionOutput = {
  /** 从客户端 faceMetrics 读出的几何结论（不是云端判断的） */
  geometry: {
    faceShape: string | null;
    confidence: string | null;
    evidence: Record<string, number>;
    source: "client_mediapipe" | "unavailable";
  };
  /** 供第 6 节发型约束规则使用的信号 */
  hairSignals: HairSignals;
  /** 已经由入口 schema 校验过的、可进入首轮 Agent 的额外客户端测算信号。 */
  clientSignals: Record<string, unknown>;
  hasFullBody: boolean;
};

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

function extractClientSignals(faceMetrics: unknown): Record<string, unknown> {
  const classification = (faceMetrics as { classification?: unknown } | null | undefined)?.classification;
  if (!classification || typeof classification !== "object" || Array.isArray(classification)) return {};

  // `raw` 可能包含 478 点 landmark；它只用于客户端展示，既不需要也不应送入模型。
  const allowed = ["visualYouthfulness", "facialGenderTendency", "cheekboneCoverageNeed"];
  return Object.fromEntries(
    allowed.flatMap((key) => {
      const value = (classification as Record<string, unknown>)[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
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
    const clientSignals = extractClientSignals(photo.faceMetrics);

    const profile = await deps.prisma.appearanceProfile.findUnique({ where: { userId: ctx.userId } });

    let hairSignals: HairSignals = {
      hairline,
      volume,
      selfReportedHairLossConcern: profile?.hairLossConcern ?? false,
      selfReportedVolume: profile?.selfReportedHairVolume ?? undefined,
    };

    // 用户确认过的脸型优先于计算值（决策 5）
    if (profile?.confirmedFaceShape) {
      geometry.faceShape = profile.confirmedFaceShape;
      geometry.confidence = "user_confirmed";
    }

    return {
      status: "completed",
      data: {
        geometry,
        hairSignals,
        clientSignals,
        hasFullBody: Boolean(input.fullBodyPhotoStorageKey),
      },
    };
  },
};
