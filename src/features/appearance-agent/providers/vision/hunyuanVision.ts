import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import { env, required } from "../../../../config/env.js";
import type { VisionAnalysisInput, VisionAnalysisProvider, VisionAnalysisResult } from "./types.js";

// Tencent Hunyuan's OpenAI-compatible endpoint; vision-capable chat model.
const MODEL_ID = "hunyuan-vision";

export function createHunyuanVisionProvider(): VisionAnalysisProvider {
  const provider = createOpenAICompatible({
    name: "hunyuan",
    apiKey: required("TENCENT_HUNYUAN_API_KEY"),
    baseURL: env.hunyuan.baseURL,
  });
  const model = provider(MODEL_ID);

  return {
    name: "hunyuan-vision",
    async analyze(input: VisionAnalysisInput): Promise<VisionAnalysisResult> {
      const start = Date.now();
      const { text, usage } = await generateText({
        model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: input.prompt },
              { type: "image", image: input.imageUrl },
            ],
          },
        ],
      });
      return {
        provider: "hunyuan-vision",
        model: MODEL_ID,
        rawText: text,
        latencyMs: Date.now() - start,
        usage,
      };
    },
  };
}
