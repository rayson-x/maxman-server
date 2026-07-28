import { env, required } from "../../../../config/env.js";
import type { ImageEditInput, ImageEditProvider, ImageEditResult } from "./types.js";

/**
 * 火山方舟 Seedream 图生图编辑。
 *
 * 接入动因：SeedEdit 3.0 实测把**整幅画面**重画（原图痘印毛孔被磨掉、脸被削窄、
 * 未编辑的墙面漂移达采样地板的 24 倍），且输出被钳死在短边 864——喂多大的源图都一样。
 * 详见 src/scripts/bench-image-edit.ts 的对照结论。
 *
 * 与 volcengineImageEdit.ts 的关键差异：
 *   - **凭证不同**：这里走方舟的 Bearer API Key（ARK_API_KEY），不是视觉智能的 AK/SK
 *   - **同步返回**，没有 submit→poll 两段，也不占视觉智能那个并发=1 的信号量
 *   - **`size` 可控**（"2K"），这是唯一能突破分辨率天花板的一条
 *   - **不支持 negative_prompt**：方舟 images/generations 没有这个字段。
 *     所以「别磨皮/别换背景」这类约束在这个 provider 上必须走正向 prompt，
 *     调用方传进来的 negativePrompt 会被追加成正向的「避免…」子句而不是静默丢弃。
 *
 * 文档：https://www.volcengine.com/docs/82379/1541523
 */
// 4.0 在真人照对照台上比 SeedEdit 基准还差（墙面漂移 18-22 vs 基准 5.3-6.0）；
// 5.0 lite 质感最好但会自作主张把正脸转成侧脸构图，结构不可控。4.5 两项都稳。
// 见 src/scripts/bench-image-edit.ts 的对照结论。
const DEFAULT_MODEL_ID = "doubao-seedream-4-5-251128";
const SIZE = process.env.ARK_IMAGE_EDIT_SIZE ?? "2K";

type ArkImageResponse = {
  data?: Array<{ url?: string; b64_json?: string; revised_prompt?: string }>;
  error?: { code?: string; message?: string };
  usage?: unknown;
};

/**
 * @param modelOverride 显式指定模型档位。线上从 env 取单一默认值即可，
 *   但 bench-image-edit.ts 要在一次运行里横跨 4.0/4.5/5.0 三档对照，
 *   所以模型必须能按实例传，不能只做成模块级常量。
 */
export function createArkSeedreamImageEditProvider(modelOverride?: string): ImageEditProvider {
  const apiKey = required("ARK_API_KEY");
  const model = modelOverride ?? process.env.ARK_IMAGE_EDIT_MODEL ?? DEFAULT_MODEL_ID;

  return {
    name: `ark-seedream-image-edit(${model})`,
    async edit(input: ImageEditInput): Promise<ImageEditResult> {
      const start = Date.now();

      // 方舟文档只写了公网 URL，但 image 字段实际接受 data URI；
      // 优先用 URL（省一次 base64 膨胀），没有才退回内联。
      const image = input.imageUrl ?? (input.imageBase64 ? `data:image/jpeg;base64,${input.imageBase64}` : undefined);
      if (!image) throw new Error("ark-seedream needs imageUrl or imageBase64");

      // 没有 negative_prompt 字段，转成正向的回避子句，别让约束凭空消失
      const prompt = input.negativePrompt
        ? `${input.instruction} 避免出现：${input.negativePrompt}`
        : input.instruction;

      const res = await fetch(`${env.ark.baseURL}/images/generations`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          prompt,
          image,
          size: SIZE,
          response_format: "url",
          watermark: false,
          sequential_image_generation: "disabled",
          ...(input.seed !== undefined && input.seed >= 0 ? { seed: input.seed } : {}),
        }),
      });

      const json = (await res.json()) as ArkImageResponse;
      if (!res.ok) {
        throw new Error(`ARK error (${res.status}): ${json.error?.code ?? ""} ${json.error?.message ?? JSON.stringify(json)}`);
      }

      const first = json.data?.[0];
      return {
        provider: `ark-seedream-image-edit(${model})`,
        imageUrl: first?.url,
        imageBase64: first?.b64_json,
        latencyMs: Date.now() - start,
        raw: json,
      };
    },
  };
}
