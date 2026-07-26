import { submitVolcVisualTask, pollVolcVisualResult, withVolcTaskSlot } from "../volcengine/signedRequest.js";
import type { ClothingSwapInput, ClothingSwapProvider, ClothingSwapResult } from "./types.js";

// req_key confirmed against the official 图片换装 doc: V1 "dressing_diffusion",
// called via the same CVSync2AsyncSubmitTask/CVSync2AsyncGetResult pattern as
// img2img. V2 ("dressing_diffusionV2", supports upper+lower garments in one
// call) is documented under a different Action pair (CVSubmitTask/CVGetResult,
// not "Sync2Async") that hasn't been empirically verified — not used here.
const REQ_KEY = process.env.VOLC_CLOTHING_SWAP_REQ_KEY ?? "dressing_diffusion";

export function createVolcengineClothingSwapProvider(): ClothingSwapProvider {
  return {
    name: "volcengine-outfit-swap",
    async swap(input: ClothingSwapInput): Promise<ClothingSwapResult> {
      const start = Date.now();
      if (!input.personImageUrl || !input.garmentImageUrl) {
        throw new Error(
          "volcengine-outfit-swap (dressing_diffusion V1) requires personImageUrl and garmentImageUrl; base64 input is not supported by this req_key",
        );
      }

      const body: Record<string, unknown> = {
        model: { id: "1", url: input.personImageUrl },
        garment: { id: "1", data: [{ url: input.garmentImageUrl }] },
      };

      // 同 imageEdit：整个生命周期在信号量内（tasks 11.2）
      return withVolcTaskSlot(REQ_KEY, async () => {
        const submit = await submitVolcVisualTask(REQ_KEY, body, { purpose: "clothing-swap" });
        const taskId = submit.data?.task_id;
        if (!taskId) throw new Error(`Volcengine submit did not return a task_id: ${JSON.stringify(submit)}`);

        const result = await pollVolcVisualResult(REQ_KEY, taskId);
        return {
          provider: "volcengine-outfit-swap",
          imageUrl: result.data?.image_urls?.[0],
          callId: taskId,
          latencyMs: Date.now() - start,
          raw: result,
        };
      });
    },
  };
}
