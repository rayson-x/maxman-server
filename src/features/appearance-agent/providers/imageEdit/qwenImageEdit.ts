import { env, required } from "../../../../config/env.js";
import type { ImageEditInput, ImageEditProvider, ImageEditResult } from "./types.js";

/**
 * 通义千问 Qwen-Image-Edit 指令编辑。
 *
 * 接口是**同步**的 multimodal-generation（不是 wanx 那套 async task），
 * 文档：https://help.aliyun.com/zh/model-studio/qwen-image-edit-api
 *
 * ⚠ `prompt_extend` 默认 true，会把指令改写成它自己的长 prompt。
 * 我们的 `renderDescription` 是逐款校准出来的措辞（见 objectiveHairstyleAttributes.ts），
 * 被改写就等于校准全部作废，所以这里必须显式关掉。
 */
const MODEL_ID = process.env.ALIYUN_QWEN_IMAGE_EDIT_MODEL ?? "qwen-image-edit-plus";
const GENERATION_PATH = "/services/aigc/multimodal-generation/generation";

type QwenEditResponse = {
  output?: {
    choices?: Array<{ message?: { content?: Array<{ image?: string }> } }>;
  };
  request_id?: string;
  code?: string;
  message?: string;
};

/** 响应里图片藏在 choices[].message.content[].image，逐层兜底取第一张 */
function firstImageUrl(json: QwenEditResponse): string | undefined {
  for (const choice of json.output?.choices ?? []) {
    for (const part of choice.message?.content ?? []) {
      if (part.image) return part.image;
    }
  }
  return undefined;
}

export function createQwenImageEditProvider(): ImageEditProvider {
  const apiKey = required("ALIYUN_DASHSCOPE_API_KEY");

  return {
    name: "qwen-image-edit",
    async edit(input: ImageEditInput): Promise<ImageEditResult> {
      const start = Date.now();
      const baseURL = env.aliyun.nativeBaseURL;
      if (!baseURL) throw new Error("Missing ALIYUN_DASHSCOPE_NATIVE_BASE_URL");

      const image = input.imageUrl ?? (input.imageBase64 ? `data:image/jpeg;base64,${input.imageBase64}` : undefined);
      if (!image) throw new Error("qwen-image-edit needs imageUrl or imageBase64");

      const res = await fetch(`${baseURL}${GENERATION_PATH}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL_ID,
          input: {
            messages: [{ role: "user", content: [{ image }, { text: input.instruction }] }],
          },
          parameters: {
            n: 1,
            prompt_extend: false,
            watermark: false,
            ...(input.seed !== undefined && input.seed >= 0 ? { seed: input.seed } : {}),
            ...(input.negativePrompt ? { negative_prompt: input.negativePrompt } : {}),
          },
        }),
      });

      const json = (await res.json()) as QwenEditResponse;
      if (!res.ok) {
        throw new Error(`DashScope error (${res.status}): ${json.code ?? ""} ${json.message ?? JSON.stringify(json)}`);
      }

      return {
        provider: "qwen-image-edit",
        imageUrl: firstImageUrl(json),
        callId: json.request_id,
        latencyMs: Date.now() - start,
        raw: json,
      };
    },
  };
}
