/**
 * Composition root for the appearance-agent feature. This is the ONLY place
 * allowed to read env vars to pick a concrete vendor (design.md decision 16:
 * provider selection is a runtime config choice, not hardcoded into
 * agent/tool definitions) and the only place that holds cached singleton
 * instances. Everything downstream (tools, the agent itself) receives its
 * dependencies as constructor arguments — see agent.ts / tools/*.
 *
 * Switch active providers via env vars, e.g.:
 *   ACTIVE_VISION_PROVIDER=zhipu|qwen|hunyuan   (default: zhipu)
 *   ACTIVE_IMAGE_EDIT_PROVIDER=volcengine|qwen|stepfun  (default: volcengine)
 *   ACTIVE_CLOTHING_PROVIDER=volcengine         (only viable one so far)
 *   ACTIVE_TEXT_TO_IMAGE_PROVIDER=zhipu         (only viable one so far)
 *   ACTIVE_TEXT_PLANNING_PROVIDER=deepseek      (only viable one so far)
 *   ACTIVE_FREE_RECOMMENDATION_PROVIDER=deepseek (only viable one so far)
 *   ACTIVE_ADVERSARIAL_REVIEW_PROVIDER=deepseek (only viable one so far)
 *   ACTIVE_INPUT_REVIEW_PROVIDER=deepseek      (only viable one so far)
 */
import { createZhipuVisionProvider } from "./providers/vision/zhipuVision.js";
import { createQwenVisionProvider } from "./providers/vision/qwenVision.js";
import { createHunyuanVisionProvider } from "./providers/vision/hunyuanVision.js";
import type { VisionAnalysisProvider } from "./providers/vision/types.js";

import { createVolcengineImageEditProvider } from "./providers/imageEdit/volcengineImageEdit.js";
import { createQwenImageEditProvider } from "./providers/imageEdit/qwenImageEdit.js";
import { createStepFunImageEditProvider } from "./providers/imageEdit/stepfunImageEdit.js";
import type { ImageEditProvider } from "./providers/imageEdit/types.js";

import { createVolcengineClothingSwapProvider } from "./providers/clothing/volcengineClothingSwap.js";
import { createHunyuanClothingSwapProvider } from "./providers/clothing/hunyuanClothingSwap.js";
import type { ClothingSwapProvider } from "./providers/clothing/types.js";

import { createZhipuTextToImageProvider } from "./providers/textToImage/zhipuTextToImage.js";
import type { TextToImageProvider } from "./providers/textToImage/types.js";

import { createDeepSeekTextPlanningProvider } from "./providers/textPlanning/deepseekTextPlanning.js";
import type { TextPlanningProvider } from "./providers/textPlanning/types.js";

import { createDeepSeekFreeRecommendationProvider } from "./providers/freeRecommendation/deepseekFreeRecommendation.js";
import type { FreeRecommendationProvider } from "./providers/freeRecommendation/types.js";

import { createDeepSeekAdversarialReviewProvider } from "./providers/adversarialReview/deepseekAdversarialReview.js";
import type { AdversarialReviewProvider } from "./providers/adversarialReview/types.js";

import { createDeepSeekInputReviewProvider } from "./providers/inputReview/deepseekInputReview.js";
import type { InputReviewProvider } from "./providers/inputReview/types.js";

import { createDeepSeekModel } from "./providers/llm/deepseekModel.js";
import { createAppearanceAgent, type AppearanceAgentDeps } from "./agent.js";

function pick<T>(name: string, factories: Record<string, () => T>, fallback: string): T {
  const key = process.env[name] ?? fallback;
  const factory = factories[key];
  if (!factory) {
    throw new Error(`Unknown provider "${key}" for ${name}. Available: ${Object.keys(factories).join(", ")}`);
  }
  return factory();
}

let visionProvider: VisionAnalysisProvider | undefined;
export function getVisionAnalysisProvider(): VisionAnalysisProvider {
  return (visionProvider ??= pick(
    "ACTIVE_VISION_PROVIDER",
    {
      zhipu: createZhipuVisionProvider,
      qwen: createQwenVisionProvider,
      hunyuan: createHunyuanVisionProvider,
    },
    "zhipu",
  ));
}

let imageEditProvider: ImageEditProvider | undefined;
export function getImageEditProvider(): ImageEditProvider {
  return (imageEditProvider ??= pick(
    "ACTIVE_IMAGE_EDIT_PROVIDER",
    {
      volcengine: createVolcengineImageEditProvider,
      qwen: createQwenImageEditProvider,
      // tasks 12.1：代码就绪，缺凭证。接入动因是火山并发=1 的吞吐天花板
      stepfun: createStepFunImageEditProvider,
    },
    "volcengine",
  ));
}

let clothingSwapProvider: ClothingSwapProvider | undefined;
export function getClothingSwapProvider(): ClothingSwapProvider {
  return (clothingSwapProvider ??= pick(
    "ACTIVE_CLOTHING_PROVIDER",
    {
      volcengine: createVolcengineClothingSwapProvider,
      hunyuan: createHunyuanClothingSwapProvider, // currently throws — see file comment, kept for future re-check
    },
    "volcengine",
  ));
}

let textToImageProvider: TextToImageProvider | undefined;
export function getTextToImageProvider(): TextToImageProvider {
  return (textToImageProvider ??= pick(
    "ACTIVE_TEXT_TO_IMAGE_PROVIDER",
    {
      zhipu: createZhipuTextToImageProvider,
    },
    "zhipu",
  ));
}

let textPlanningProvider: TextPlanningProvider | undefined;
export function getTextPlanningProvider(): TextPlanningProvider {
  return (textPlanningProvider ??= pick(
    "ACTIVE_TEXT_PLANNING_PROVIDER",
    {
      deepseek: createDeepSeekTextPlanningProvider,
    },
    "deepseek",
  ));
}

let freeRecommendationProvider: FreeRecommendationProvider | undefined;
export function getFreeRecommendationProvider(): FreeRecommendationProvider {
  return (freeRecommendationProvider ??= pick(
    "ACTIVE_FREE_RECOMMENDATION_PROVIDER",
    {
      deepseek: createDeepSeekFreeRecommendationProvider,
    },
    "deepseek",
  ));
}

let adversarialReviewProvider: AdversarialReviewProvider | undefined;
export function getAdversarialReviewProvider(): AdversarialReviewProvider {
  return (adversarialReviewProvider ??= pick(
    "ACTIVE_ADVERSARIAL_REVIEW_PROVIDER",
    {
      deepseek: createDeepSeekAdversarialReviewProvider,
    },
    "deepseek",
  ));
}

let inputReviewProvider: InputReviewProvider | undefined;
export function getInputReviewProvider(): InputReviewProvider {
  return (inputReviewProvider ??= pick(
    "ACTIVE_INPUT_REVIEW_PROVIDER",
    {
      deepseek: createDeepSeekInputReviewProvider,
    },
    "deepseek",
  ));
}

let agentDeps: AppearanceAgentDeps | undefined;
function getAppearanceAgentDeps(): AppearanceAgentDeps {
  return (agentDeps ??= {
    model: createDeepSeekModel(),
    visionProvider: getVisionAnalysisProvider(),
    imageEditProvider: getImageEditProvider(),
    clothingSwapProvider: getClothingSwapProvider(),
    textToImageProvider: getTextToImageProvider(),
    textPlanningProvider: getTextPlanningProvider(),
    freeRecommendationProvider: getFreeRecommendationProvider(),
    adversarialReviewProvider: getAdversarialReviewProvider(),
  });
}

let appearanceAgent: ReturnType<typeof createAppearanceAgent> | undefined;
/** The default, config-selected appearance agent — build it once here rather than importing a bare singleton. */
export function getAppearanceAgent() {
  return (appearanceAgent ??= createAppearanceAgent(getAppearanceAgentDeps()));
}

/** Reset all cached instances — useful in tests that swap env vars between runs. */
export function resetProviderRegistry() {
  visionProvider = undefined;
  imageEditProvider = undefined;
  clothingSwapProvider = undefined;
  textToImageProvider = undefined;
  textPlanningProvider = undefined;
  freeRecommendationProvider = undefined;
  adversarialReviewProvider = undefined;
  inputReviewProvider = undefined;
  agentDeps = undefined;
  appearanceAgent = undefined;
}
