import { Agent } from "@mastra/core/agent";
import type { createDeepSeekModel } from "./providers/llm/deepseekModel.js";
import { createAnalyzeAppearancePhotoTool } from "./tools/analyzeAppearancePhotoTool.js";
import { createEditAppearanceImageTool } from "./tools/editAppearanceImageTool.js";
import { createSwapOutfitTool } from "./tools/swapOutfitTool.js";
import { createGenerateReferenceImageTool } from "./tools/generateReferenceImageTool.js";
import { createDualSourceRecommendationAgentTools, type AgentRecommendationExecutor } from "./tools/dualSourceRecommendationTools.js";
import type { VisionAnalysisProvider } from "./providers/vision/types.js";
import type { ImageEditProvider } from "./providers/imageEdit/types.js";
import type { ClothingSwapProvider } from "./providers/clothing/types.js";
import type { TextToImageProvider } from "./providers/textToImage/types.js";

export interface AppearanceAgentDeps {
  model: ReturnType<typeof createDeepSeekModel>;
  visionProvider: VisionAnalysisProvider;
  imageEditProvider: ImageEditProvider;
  clothingSwapProvider: ClothingSwapProvider;
  textToImageProvider: TextToImageProvider;
  /** Injected by an authorized conversation entrypoint; never raw A/B access. */
  recommendationExecutor?: AgentRecommendationExecutor;
}

/**
 * The single "brain" (design.md decision 16) — model chosen purely for
 * reasoning/instruction-following/tool-calling quality, with no multimodal
 * requirement since vision/image-edit/clothing-swap are all separate tools.
 *
 * Takes every dependency explicitly (DI) — the composition root decides
 * which concrete provider/model backs each slot; nothing in here reaches
 * into a global registry.
 */
export function createAppearanceAgent(deps: AppearanceAgentDeps): Agent {
  return new Agent({
    id: "appearance-agent",
    name: "BetterMeet Appearance Agent",
    instructions:
      "你是一个形象改善助手的推理引擎。你自己看不到图片，需要的时候调用 analyze-appearance-photo 工具获取照片的结构化描述。" +
      "生成发型/仪容变化效果图时调用 edit-appearance-image 工具，且必须传入用户最初上传的原始基准照片URL，不能用之前生成过的图片作为输入。" +
      "生成换装效果图时调用 swap-outfit 工具。" +
      "如果只是需要展示一个风格/发型/服装概念的示意图（不基于用户本人照片，不是个性化效果图），才调用 generate-reference-image 工具，" +
      "并且必须明确告知用户这只是风格示意图、不是他本人的效果图。" +
      "涉及推荐时，只能调用 recommend-style-directions、recommend-hairstyles 或 recommend-wardrobe。" +
      "不得自行编造候选、直接访问目录、A/B 通道、diff 或 reviewer；每个推荐工具只接受已授权的 planId。" +
      "不要评判性描述用户外貌，不要做医学诊断。",
    model: deps.model,
    tools: {
      "analyze-appearance-photo": createAnalyzeAppearancePhotoTool(deps.visionProvider),
      "edit-appearance-image": createEditAppearanceImageTool(deps.imageEditProvider),
      "swap-outfit": createSwapOutfitTool(deps.clothingSwapProvider),
      "generate-reference-image": createGenerateReferenceImageTool(deps.textToImageProvider),
      ...createDualSourceRecommendationAgentTools(deps.recommendationExecutor),
    },
  });
}
