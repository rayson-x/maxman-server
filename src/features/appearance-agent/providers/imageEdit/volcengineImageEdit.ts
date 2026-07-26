import { submitVolcVisualTask, pollVolcVisualResult, withVolcTaskSlot } from "../volcengine/signedRequest.js";
import type { ImageEditInput, ImageEditProvider, ImageEditResult } from "./types.js";

// req_key for 即梦AI's instruction-based image edit (SeedEdit 3.0).
// Confirmed against the official doc (https://docs.volcengine.com/docs/86081/1804561):
// fixed value "seededit_v3.0". Input: 1 image (base64 or URL) + prompt
// (<=120 chars recommended, single instruction per call works best).
// Output aspect ratio follows the input image's aspect ratio, short side in [512, 1536].
const REQ_KEY = process.env.VOLC_IMAGE_EDIT_REQ_KEY ?? "seededit_v3.0";

export function createVolcengineImageEditProvider(): ImageEditProvider {
  return {
    name: "volcengine-jimeng-image-edit",
    async edit(input: ImageEditInput): Promise<ImageEditResult> {
      const start = Date.now();
      const body: Record<string, unknown> = {
        prompt: input.instruction,
        negative_prompt: "",
        seed: -1,
        scale: 0.5,
        return_url: true,
      };
      if (input.imageBase64) body.binary_data_base64 = [input.imageBase64];
      if (input.imageUrl) body.image_urls = [input.imageUrl];

      // 整个 submit→poll 在跨进程信号量保护下执行（tasks 11.2 修复）。
      // 只锁 submit 不够：供应商并发计数看的是服务端在跑几个任务，
      // 而任务在 poll 期间仍然占用配额。
      return withVolcTaskSlot(REQ_KEY, async () => {
        const submit = await submitVolcVisualTask(REQ_KEY, body, { purpose: "image-edit" });
        const taskId = submit.data?.task_id;
        if (!taskId) throw new Error(`Volcengine submit did not return a task_id: ${JSON.stringify(submit)}`);

        const result = await pollVolcVisualResult(REQ_KEY, taskId);
        return {
          provider: "volcengine-jimeng-image-edit",
          imageUrl: result.data?.image_urls?.[0],
          callId: taskId,
          latencyMs: Date.now() - start,
          raw: result,
        };
      });
    },
  };
}
