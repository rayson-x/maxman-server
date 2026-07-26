import type { Step } from "./types.js";
import type { AnalyzeVisionOutput } from "./analyzeVision.js";
import {
  createRecommendationApplication,
  type CapabilityStatus,
  type CandidateView,
} from "../services/recommendationApplication.js";

/**
 * S3 推荐。**本步骤只做输入装配与转交**，业务逻辑全在 `RecommendationApplication`。
 *
 * 抢占、幂等、照片授权、输出校验、客观属性解析、渲染指令构建都在应用模块里，
 * 因为固定管道与将来的对话 tool 必须共享同一份实现——只共享 provider 不够，
 * 两个入口仍会各自实现这些横切关注点然后行为分叉。
 *
 * 旧实现（确定性匹配 + 候选落成 `StyleProfileEntry` 行 + 自己算指纹与复用）已被取代：
 * 它依赖的风格数据为空，且候选没有稳定的引用 id。
 */

export type RecommendInput = {
  vision: AnalyzeVisionOutput;
  /** 正面照的 storageKey。应用模块负责签发短时地址并落访问记录 */
  frontPhotoStorageKey: string;
  userPreferenceText?: string;
  userPreferenceStyleTag?: string | null;
  changeWillingness?: string | null;
  hairstyleCandidateCount?: number;
};

export type RecommendOutput = {
  setId: string;
  candidates: CandidateView[];
  capabilityStatus: CapabilityStatus;
  /** 复用了已有候选集（同一输入指纹），未重新调用 provider */
  reused: boolean;
  /** 另一个请求正在生成，本次读到的是准备中的集合 */
  inProgress: boolean;
};

export const recommendStep: Step<RecommendInput, RecommendOutput> = {
  name: "S3_recommend",
  async run(input, ctx, deps) {
    if (!ctx.planId) return { status: "failed", error: "缺少 planId" };

    const app = createRecommendationApplication({
      prisma: deps.prisma,
      hairstyleProvider: deps.providers.hairstyleRecommendation,
      outfitProvider: deps.providers.outfitRecommendation,
    });

    const view = await app.recommendHairstyles({
      userId: ctx.userId,
      planId: ctx.planId,
      requestedCount: input.hairstyleCandidateCount ?? 3,
      frontPhotoStorageKey: input.frontPhotoStorageKey,
      geometry: input.vision.geometry,
      hairSignals: input.vision.hairSignals,
      // ⚠ 语义分析的**自由文本不能进指纹**：它是视觉模型的非确定性输出，
      // 两次运行必然不同 → computationKey 不同 → 抢占形同虚设、重复付费。
      // 这里只把它作为 prompt 上下文传给 provider（见 recommendationApplication
      // 的 fingerprintable 划分），不参与指纹计算。
      semantics: input.vision.semanticAnalysis ? { raw: input.vision.semanticAnalysis } : null,
      preference: input.userPreferenceText
        ? { text: input.userPreferenceText, normalizedTag: input.userPreferenceStyleTag ?? null }
        : null,
      changeWillingness: input.changeWillingness ?? null,
    });

    const data: RecommendOutput = {
      setId: view.setId,
      candidates: view.candidates,
      capabilityStatus: view.capabilityStatus,
      reused: view.reused,
      inProgress: view.inProgress,
    };

    if (view.status === "failed") return { status: "failed", error: "provider 未产出通过校验的候选" };
    if (view.candidates.length === 0) {
      // 准备中或零候选：如实标记缺口，不把空集合当成功
      return {
        status: "completed_partial",
        data,
        missing: [{
          item: "发型候选",
          reason: view.inProgress ? "另一个请求正在生成候选，请稍后重试" : "provider 未产出通过校验的候选",
        }],
      };
    }
    return { status: "completed", data };
  },
};
