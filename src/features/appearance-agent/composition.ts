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
 *   ACTIVE_IMAGE_EDIT_PROVIDER=ark|qwen|volcengine|stepfun  (default: ark)
 *   ACTIVE_CLOTHING_PROVIDER=volcengine         (only viable one so far)
 *   ACTIVE_TEXT_TO_IMAGE_PROVIDER=zhipu         (only viable one so far)
 *   ACTIVE_TEXT_PLANNING_PROVIDER=deepseek      (only viable one so far)
 *   ACTIVE_FREE_RECOMMENDATION_PROVIDER=deepseek (only viable one so far)
 *   ACTIVE_ADVERSARIAL_REVIEW_PROVIDER=deepseek (only viable one so far)
 *   ACTIVE_INPUT_REVIEW_PROVIDER=deepseek      (only viable one so far)
 *   ACTIVE_HAIRSTYLE_RECOMMENDATION_PROVIDER=multimodal-agent
 *   ACTIVE_OUTFIT_RECOMMENDATION_PROVIDER=multimodal-agent
 */
import { createZhipuVisionProvider } from "./providers/vision/zhipuVision.js";
import { createQwenVisionProvider } from "./providers/vision/qwenVision.js";
import { createHunyuanVisionProvider } from "./providers/vision/hunyuanVision.js";
import type { VisionAnalysisProvider } from "./providers/vision/types.js";

import { createVolcengineImageEditProvider } from "./providers/imageEdit/volcengineImageEdit.js";
import { createQwenImageEditProvider } from "./providers/imageEdit/qwenImageEdit.js";
import { createArkSeedreamImageEditProvider } from "./providers/imageEdit/arkSeedreamImageEdit.js";
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
import { createVisionLlmStyleRecommendationProvider } from "./providers/styleRecommendation/visionLlmStyleRecommendation.js";
import {
  createHairstyleMultimodalAgentProvider,
  createOutfitMultimodalAgentProvider,
} from "./providers/styleRecommendation/multimodalAgentRecommendation.js";
import type { InputReviewProvider } from "./providers/inputReview/types.js";
import type { StyleRecommendationProvider } from "./providers/styleRecommendation/types.js";
import { createRuleBasedPlanMaterializationProvider } from "./providers/planMaterialization/ruleBasedPlanMaterialization.js";
import type { PlanMaterializationProvider } from "./providers/planMaterialization/types.js";

import { createDeepSeekModel } from "./providers/llm/deepseekModel.js";
import { createAppearanceAgent, type AppearanceAgentDeps } from "./agent.js";
import { env } from "../../config/env.js";
import { createOpenMeteoWeatherProvider } from "./weather/openMeteoWeatherProvider.js";
import { createHistoricalTemperatureStore } from "./weather/historicalTemperatureStore.js";
import { createWeatherContextService } from "./weather/weatherContextService.js";
import { createWeatherAwareAgentRunner } from "./weather/weatherAwareAgentRunner.js";
import { meterProviderMethod } from "../../services/providerOperationMeter.js";
import type {
  HistoricalTemperatureStore,
  WeatherContextService,
  WeatherProvider,
} from "./weather/types.js";

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
      zhipu: () => meterProviderMethod(createZhipuVisionProvider(), { provider: "zhipu", operation: "vision_analysis", model: "glm-4v-flash", method: "analyze" }),
      qwen: () => meterProviderMethod(createQwenVisionProvider(), { provider: "qwen", operation: "vision_analysis", model: "qwen-vl-plus", method: "analyze" }),
      hunyuan: () => meterProviderMethod(createHunyuanVisionProvider(), { provider: "hunyuan", operation: "vision_analysis", model: "hunyuan-vision", method: "analyze" }),
    },
    "zhipu",
  ));
}

let imageEditProvider: ImageEditProvider | undefined;
export function getImageEditProvider(): ImageEditProvider {
  return (imageEditProvider ??= pick(
    "ACTIVE_IMAGE_EDIT_PROVIDER",
    {
      // Volcengine async adapters emit their charge as soon as submission is accepted in taskLedger.
      volcengine: createVolcengineImageEditProvider,
      qwen: () => meterProviderMethod(createQwenImageEditProvider(), { provider: "qwen", operation: "image_edit", model: process.env.ALIYUN_QWEN_IMAGE_EDIT_MODEL ?? "qwen-image-edit-plus", method: "edit" }),
      // 缺 ARK_API_KEY（方舟凭证与视觉智能的 AK/SK 是两套）。
      // 它是目前唯一 size 可控的一家，能突破 SeedEdit 短边 864 的天花板
      ark: () => meterProviderMethod(createArkSeedreamImageEditProvider(), { provider: "ark", operation: "image_edit", model: process.env.ARK_IMAGE_EDIT_MODEL ?? "doubao-seedream-4-5-251128", method: "edit" }),
      // tasks 12.1：代码就绪，缺凭证。接入动因是火山并发=1 的吞吐天花板
      stepfun: () => meterProviderMethod(createStepFunImageEditProvider(), { provider: "stepfun", operation: "image_edit", model: process.env.STEPFUN_IMAGE_EDIT_MODEL ?? "step-image-edit-2", method: "edit" }),
    },
    // 默认几经调整：volcengine(SeedEdit) → qwen → ark(Seedream 4.5)。
    // 真人照对照台（src/scripts/bench-image-edit.ts）依次测出：
    //   SeedEdit 3.0  重画整幅画面（磨皮削脸、墙面漂移 24 倍地板、输出钳死 1152×864）
    //   qwen          比 SeedEdit 好，但三七侧分这类需要清楚分缝的款式结构偏软
    //   Seedream 4.0  比 SeedEdit 基准还差（墙面漂移 18-22）
    //   Seedream 5.0 lite  质感最好，但会自作主张把正脸转成侧脸构图——结构不可控
    //   Seedream 4.5  发丝质感和皮肤保真度最好，且两款测试都保持正脸构图 → 定为默认
    // 15 款 renderDescription 已按 Seedream 4.5 重校（11 款原样通过、4 款改措辞），
    // 且 prompt 结构随之改为「约束前置 + 带发型名」——见 composeEditInstruction。
    // ⚠ 方舟是三套凭证里最新接入的一套（ARK_API_KEY，与视觉智能的 AK/SK 是分开的两套），
    // 尚未在生产流量下跑过。
    "ark",
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
      zhipu: () => meterProviderMethod(createZhipuTextToImageProvider(), { provider: "zhipu", operation: "text_to_image", model: "cogview-3-flash", method: "generate" }),
    },
    "zhipu",
  ));
}

let textPlanningProvider: TextPlanningProvider | undefined;
export function getTextPlanningProvider(): TextPlanningProvider {
  return (textPlanningProvider ??= pick(
    "ACTIVE_TEXT_PLANNING_PROVIDER",
    {
      deepseek: () => meterProviderMethod(createDeepSeekTextPlanningProvider(), { provider: "deepseek", operation: "text_planning", model: "deepseek-v4-flash", method: "scoreCandidates" }),
    },
    "deepseek",
  ));
}

let freeRecommendationProvider: FreeRecommendationProvider | undefined;
export function getFreeRecommendationProvider(): FreeRecommendationProvider {
  return (freeRecommendationProvider ??= pick(
    "ACTIVE_FREE_RECOMMENDATION_PROVIDER",
    {
      deepseek: () => meterProviderMethod(createDeepSeekFreeRecommendationProvider(), { provider: "deepseek", operation: "free_recommendation", model: "deepseek-v4-flash", method: "suggest" }),
    },
    "deepseek",
  ));
}

let adversarialReviewProvider: AdversarialReviewProvider | undefined;
export function getAdversarialReviewProvider(): AdversarialReviewProvider {
  return (adversarialReviewProvider ??= pick(
    "ACTIVE_ADVERSARIAL_REVIEW_PROVIDER",
    {
      deepseek: () => meterProviderMethod(createDeepSeekAdversarialReviewProvider(), { provider: "deepseek", operation: "adversarial_review", model: "deepseek-v4-flash", method: "review" }),
    },
    "deepseek",
  ));
}


let inputReviewProvider: InputReviewProvider | undefined;
export function getInputReviewProvider(): InputReviewProvider {
  return (inputReviewProvider ??= pick(
    "ACTIVE_INPUT_REVIEW_PROVIDER",
    {
      deepseek: () => meterProviderMethod(createDeepSeekInputReviewProvider(), { provider: "deepseek", operation: "input_review", model: "deepseek-v4-flash", method: "review" }),
    },
    "deepseek",
  ));
}

let styleRecommendationProvider: StyleRecommendationProvider | undefined;
/**
 * 方案推荐。**这是一条刻意设计的接缝**——过渡期是视觉 LLM 直接看图推荐，
 * 审美匹配数据到位后换成 `catalog-matching`，上游一行不改。
 * 见 openspec/changes/add-pluggable-style-recommendation。
 */
export function getStyleRecommendationProvider(): StyleRecommendationProvider {
  return (styleRecommendationProvider ??= pick(
    "ACTIVE_STYLE_RECOMMENDATION_PROVIDER",
    {
      "vision-llm": () =>
        meterProviderMethod(createVisionLlmStyleRecommendationProvider({
          modelId: process.env.STYLE_RECOMMENDATION_MODEL,
        }), {
          provider: "zhipu",
          operation: "style_recommendation",
          model: process.env.STYLE_RECOMMENDATION_MODEL ?? "glm-4v-flash",
          method: "recommend",
        }),
      // "catalog-matching": 待审美匹配数据到位后实现（tasks 8.5）
    },
    "vision-llm",
  ));
}

let hairstyleRecProvider: ReturnType<typeof createHairstyleMultimodalAgentProvider> | undefined;
/** 发型推荐 adapter。`RecommendationApplication` 的内部可替换件 */
export function getHairstyleRecommendationProvider() {
  return (hairstyleRecProvider ??= pick(
    "ACTIVE_HAIRSTYLE_RECOMMENDATION_PROVIDER",
    { "multimodal-agent": () => meterProviderMethod(createHairstyleMultimodalAgentProvider(), { provider: "zhipu", operation: "hairstyle_recommendation", model: process.env.RECOMMENDATION_MODEL ?? "glm-4.6v", method: "recommend" }) },
    "multimodal-agent",
  ));
}

let outfitRecProvider: ReturnType<typeof createOutfitMultimodalAgentProvider> | undefined;
export function getOutfitRecommendationProvider() {
  return (outfitRecProvider ??= pick(
    "ACTIVE_OUTFIT_RECOMMENDATION_PROVIDER",
    { "multimodal-agent": () => meterProviderMethod(createOutfitMultimodalAgentProvider(), { provider: "zhipu", operation: "outfit_recommendation", model: process.env.RECOMMENDATION_MODEL ?? "glm-4.6v", method: "recommend" }) },
    "multimodal-agent",
  ));
}

let planMaterializationProvider: PlanMaterializationProvider | undefined;
export function getPlanMaterializationProvider(): PlanMaterializationProvider {
  return (planMaterializationProvider ??= pick(
    "ACTIVE_PLAN_MATERIALIZATION_PROVIDER",
    { "rule-based": createRuleBasedPlanMaterializationProvider },
    "rule-based",
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
  });
}

let appearanceAgent: ReturnType<typeof createAppearanceAgent> | undefined;
/** Internal base Agent. Recommendation callers must use the weather-aware runner below. */
function getBaseAppearanceAgent() {
  return (appearanceAgent ??= createAppearanceAgent(getAppearanceAgentDeps()));
}

function configuredForecastDays(): 7 | 10 | 15 {
  if (
    env.weather.forecastDays !== 7 &&
    env.weather.forecastDays !== 10 &&
    env.weather.forecastDays !== 15
  ) {
    throw new Error("WEATHER_FORECAST_DAYS must be 7, 10, or 15");
  }
  return env.weather.forecastDays;
}

let weatherProvider: WeatherProvider | undefined;
export function getWeatherProvider(): WeatherProvider {
  return (weatherProvider ??= createOpenMeteoWeatherProvider({
    geocodingOrigin: env.weather.geocodingOrigin,
    archiveOrigin: env.weather.archiveOrigin,
    forecastOrigin: env.weather.forecastOrigin,
    allowedOrigins: [
      env.weather.geocodingOrigin,
      env.weather.archiveOrigin,
      env.weather.forecastOrigin,
    ],
    apiKey: env.weather.apiKey,
    requestTimeoutMs: env.weather.requestTimeoutMs,
    maxResponseBytes: env.weather.maxResponseBytes,
  }));
}

let historicalTemperatureStore: HistoricalTemperatureStore | undefined;
export function getHistoricalTemperatureStore(): HistoricalTemperatureStore {
  if (
    !Number.isFinite(env.weather.historyRefreshHours) ||
    env.weather.historyRefreshHours < 0
  ) {
    throw new Error(
      "WEATHER_HISTORY_REFRESH_HOURS must be a non-negative number",
    );
  }
  return (historicalTemperatureStore ??= createHistoricalTemperatureStore({
    rootDir: env.weather.historyDir,
    maxAgeMs: env.weather.historyRefreshHours * 60 * 60 * 1_000,
  }));
}

let weatherContextService: WeatherContextService | undefined;
export function getWeatherContextService(): WeatherContextService {
  return (weatherContextService ??= createWeatherContextService({
    provider: getWeatherProvider(),
    historyStore: getHistoricalTemperatureStore(),
    forecastDays: configuredForecastDays(),
  }));
}

function createDefaultWeatherAwareAppearanceAgentRunner() {
  const agentAdapter = {
    generate(prompt: string, options?: { system?: string }) {
      return getBaseAppearanceAgent().generate(prompt, {
        system: options?.system,
      });
    },
  };
  return createWeatherAwareAgentRunner({
    agent: agentAdapter,
    weatherContextService: getWeatherContextService(),
  });
}

let weatherAwareAppearanceAgentRunner:
  | ReturnType<typeof createDefaultWeatherAwareAppearanceAgentRunner>
  | undefined;
/**
 * Resolve/fetch weather immediately before each Agent run and inject it as a
 * request-local system message. The cached Agent's base instructions are never
 * mutated, so one user's city cannot leak into another user's request.
 */
export function getWeatherAwareAppearanceAgentRunner() {
  if (!weatherAwareAppearanceAgentRunner) {
    weatherAwareAppearanceAgentRunner =
      createDefaultWeatherAwareAppearanceAgentRunner();
  }
  return weatherAwareAppearanceAgentRunner;
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
  weatherProvider = undefined;
  historicalTemperatureStore = undefined;
  weatherContextService = undefined;
  styleRecommendationProvider = undefined;
  hairstyleRecProvider = undefined;
  outfitRecProvider = undefined;
  weatherAwareAppearanceAgentRunner = undefined;
}
