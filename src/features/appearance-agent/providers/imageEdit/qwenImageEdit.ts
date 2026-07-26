import { env, required } from "../../../../config/env.js";
import type { ImageEditInput, ImageEditProvider, ImageEditResult } from "./types.js";

// DashScope's native (non-OpenAI-compatible) async task API for Tongyi
// Wanxiang image editing. Exact path/model id should be confirmed against
// https://help.aliyun.com/zh/model-studio/wanx-image-edit-api-reference on
// first real call — these are best-effort defaults, overridable via env.
const MODEL_ID = process.env.ALIYUN_WANX_IMAGE_EDIT_MODEL ?? "wanx2.1-imageedit";
const SYNTHESIS_PATH = process.env.ALIYUN_WANX_IMAGE_EDIT_PATH ?? "/services/aigc/image2image/image-synthesis";

async function dashscopeFetch(path: string, init: RequestInit) {
  const baseURL = env.aliyun.nativeBaseURL;
  if (!baseURL) throw new Error("Missing ALIYUN_DASHSCOPE_NATIVE_BASE_URL");
  const res = await fetch(`${baseURL}${path}`, init);
  const json = await res.json();
  if (!res.ok) throw new Error(`DashScope error (${res.status}): ${JSON.stringify(json)}`);
  return json;
}

export function createQwenImageEditProvider(): ImageEditProvider {
  const apiKey = required("ALIYUN_DASHSCOPE_API_KEY");

  return {
    name: "qwen-wanx-image-edit",
    async edit(input: ImageEditInput): Promise<ImageEditResult> {
      const start = Date.now();

      const submitJson = (await dashscopeFetch(SYNTHESIS_PATH, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "X-DashScope-Async": "enable",
        },
        body: JSON.stringify({
          model: MODEL_ID,
          input: {
            function: "description_edit",
            prompt: input.instruction,
            base_image_url: input.imageUrl,
          },
          parameters: { n: 1 },
        }),
      })) as { output?: { task_id?: string } };

      const taskId = submitJson.output?.task_id;
      if (!taskId) throw new Error(`DashScope submit did not return a task_id: ${JSON.stringify(submitJson)}`);

      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const statusJson = (await dashscopeFetch(`/tasks/${taskId}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${apiKey}` },
        })) as { output?: { task_status?: string; results?: Array<{ url?: string }> } };

        const status = statusJson.output?.task_status;
        if (status === "SUCCEEDED") {
          return {
            provider: "qwen-wanx-image-edit",
            imageUrl: statusJson.output?.results?.[0]?.url,
            latencyMs: Date.now() - start,
            raw: statusJson,
          };
        }
        if (status === "FAILED" || status === "UNKNOWN") {
          throw new Error(`DashScope task ${taskId} failed: ${JSON.stringify(statusJson)}`);
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      throw new Error(`DashScope task ${taskId} timed out`);
    },
  };
}
