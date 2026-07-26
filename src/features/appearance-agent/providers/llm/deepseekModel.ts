import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { env, required } from "../../../../config/env.js";

/**
 * DeepSeek as the agent's reasoning "brain" (see design.md decision 16:
 * agent+tool composition — the brain does not need multimodal input,
 * vision/image-edit/clothing-swap are separate tools it calls).
 */
export function createDeepSeekModel(modelId = "deepseek-v4-flash") {
  const provider = createOpenAICompatible({
    name: "deepseek",
    apiKey: required("DEEPSEEK_API_KEY"),
    baseURL: env.deepseek.baseURL,
  });
  return provider(modelId);
}
