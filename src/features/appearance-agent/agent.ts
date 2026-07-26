import { Agent } from "@mastra/core/agent";
import type { createDeepSeekModel } from "./providers/llm/deepseekModel.js";
import { createAnalyzeAppearancePhotoTool } from "./tools/analyzeAppearancePhotoTool.js";
import { createEditAppearanceImageTool } from "./tools/editAppearanceImageTool.js";
import { createSwapOutfitTool } from "./tools/swapOutfitTool.js";
import { createGenerateReferenceImageTool } from "./tools/generateReferenceImageTool.js";
import { createRecommendDirectionsTool } from "./tools/recommendDirectionsTool.js";
import { createSuggestUnconstrainedDirectionsTool } from "./tools/suggestUnconstrainedDirectionsTool.js";
import { createAdversarialReviewTool } from "./tools/adversarialReviewTool.js";
import type { VisionAnalysisProvider } from "./providers/vision/types.js";
import type { ImageEditProvider } from "./providers/imageEdit/types.js";
import type { ClothingSwapProvider } from "./providers/clothing/types.js";
import type { TextToImageProvider } from "./providers/textToImage/types.js";
import type { TextPlanningProvider } from "./providers/textPlanning/types.js";
import type { FreeRecommendationProvider } from "./providers/freeRecommendation/types.js";
import type { AdversarialReviewProvider } from "./providers/adversarialReview/types.js";

export interface AppearanceAgentDeps {
  model: ReturnType<typeof createDeepSeekModel>;
  visionProvider: VisionAnalysisProvider;
  imageEditProvider: ImageEditProvider;
  clothingSwapProvider: ClothingSwapProvider;
  textToImageProvider: TextToImageProvider;
  textPlanningProvider: TextPlanningProvider;
  freeRecommendationProvider: FreeRecommendationProvider;
  adversarialReviewProvider: AdversarialReviewProvider;
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
      "如果需要分析用户在发型(hair)或穿搭(outfit_accessory)方向上适合/可以发展的具体方法，调用 recommend-appearance-directions 工具——" +
      "这个工具只会从人工审核过的方法目录里返回候选项和各维度评分，你不能自己凭空发明目录之外的改造方法，也不要自己把这些评分加权排出最终优先级，" +
      "那是后端固定公式的职责，你只负责基于这些评分和理由生成给用户看的解释文案。" +
      "如果用户明确要求更大胆/更全面的建议（不只是目录内的保守方案），调用 suggest-unconstrained-directions 获取不受限制的建议，" +
      "但这些建议未经验证，绝对不能直接展示给用户——必须紧接着调用 adversarial-review-recommendations，把这两组结果一起传进去做对抗式审查，" +
      "只有 verdict=accept 的自由建议才可以呈现给用户，reject 的要说明被否决的原因，needs_professional_review 的要建议用户咨询专业人士。" +
      "不要评判性描述用户外貌，不要做医学诊断。",
    model: deps.model,
    tools: {
      "analyze-appearance-photo": createAnalyzeAppearancePhotoTool(deps.visionProvider),
      "edit-appearance-image": createEditAppearanceImageTool(deps.imageEditProvider),
      "swap-outfit": createSwapOutfitTool(deps.clothingSwapProvider),
      "generate-reference-image": createGenerateReferenceImageTool(deps.textToImageProvider),
      "recommend-appearance-directions": createRecommendDirectionsTool(deps.textPlanningProvider),
      "suggest-unconstrained-directions": createSuggestUnconstrainedDirectionsTool(deps.freeRecommendationProvider),
      "adversarial-review-recommendations": createAdversarialReviewTool(deps.adversarialReviewProvider),
    },
  });
}
