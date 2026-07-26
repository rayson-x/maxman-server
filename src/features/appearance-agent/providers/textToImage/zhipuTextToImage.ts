import { env, required } from "../../../../config/env.js";
import type { TextToImageInput, TextToImageProvider, TextToImageResult } from "./types.js";

// Confirmed against a live call: POST {baseURL}/images/generations, model
// "cogview-3-flash", body {model, prompt, size}, sync response
// {data: [{url}]} (OpenAI images-API shape). No task_id/polling involved.
const MODEL_ID = "cogview-3-flash";

export function createZhipuTextToImageProvider(): TextToImageProvider {
  return {
    name: "zhipu-cogview",
    async generate(input: TextToImageInput): Promise<TextToImageResult> {
      const start = Date.now();
      const res = await fetch(`${env.zhipu.baseURL}/images/generations`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${required("ZHIPU_API_KEY")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL_ID,
          prompt: input.prompt,
          size: input.size ?? "1024x1024",
        }),
      });
      const json = (await res.json()) as { data?: Array<{ url?: string }>; error?: { message?: string } };
      if (!res.ok) {
        throw new Error(`Zhipu CogView error (${res.status}): ${JSON.stringify(json)}`);
      }
      return {
        provider: "zhipu-cogview",
        imageUrl: json.data?.[0]?.url,
        latencyMs: Date.now() - start,
        raw: json,
      };
    },
  };
}
