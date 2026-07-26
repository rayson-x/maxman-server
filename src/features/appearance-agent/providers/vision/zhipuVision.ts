import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import { env, required } from "../../../../config/env.js";
import type { VisionAnalysisInput, VisionAnalysisProvider, VisionAnalysisResult } from "./types.js";

const MODEL_ID = "glm-4v-flash";

export function createZhipuVisionProvider(): VisionAnalysisProvider {
  const provider = createOpenAICompatible({
    name: "zhipu",
    apiKey: required("ZHIPU_API_KEY"),
    baseURL: env.zhipu.baseURL,
  });
  const model = provider(MODEL_ID);

  return {
    name: "zhipu-glm-4v",
    async analyze(input: VisionAnalysisInput): Promise<VisionAnalysisResult> {
      const start = Date.now();
      const { text } = await generateText({
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
        provider: "zhipu-glm-4v",
        model: MODEL_ID,
        rawText: text,
        latencyMs: Date.now() - start,
      };
    },
  };
}
