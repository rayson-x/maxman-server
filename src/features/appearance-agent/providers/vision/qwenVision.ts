import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import { env, required } from "../../../../config/env.js";
import type { VisionAnalysisInput, VisionAnalysisProvider, VisionAnalysisResult } from "./types.js";

// Qwen-VL served through this Aliyun DashScope endpoint's OpenAI-compatible mode.
const MODEL_ID = "qwen-vl-plus";

export function createQwenVisionProvider(): VisionAnalysisProvider {
  const baseURL = env.aliyun.openaiBaseURL;
  if (!baseURL) throw new Error("Missing ALIYUN_DASHSCOPE_OPENAI_BASE_URL");

  const provider = createOpenAICompatible({
    name: "qwen",
    apiKey: required("ALIYUN_DASHSCOPE_API_KEY"),
    baseURL,
  });
  const model = provider(MODEL_ID);

  return {
    name: "qwen-vl",
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
        provider: "qwen-vl",
        model: MODEL_ID,
        rawText: text,
        latencyMs: Date.now() - start,
        usage,
      };
    },
  };
}
