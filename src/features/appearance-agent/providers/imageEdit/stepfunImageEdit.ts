import { env, required } from "../../../../config/env.js";
import type { ImageEditInput, ImageEditProvider, ImageEditResult } from "./types.js";

/**
 * 阶跃星辰 Step-Image-Edit-2（tasks 12.1）。
 *
 * 存在的理由是**吞吐天花板**（design.md 决策 12）：火山引擎图生图并发上限为 1
 * （账号级全局，实测 code 50430），每张 13 秒，全系统吞吐上限约 46-92 用户/小时。
 * StepFun 的公开参数是 0.5-2 秒出图、¥0.02/张——比火山快约 10 倍、便宜约 10 倍。
 * 若可用，onboarding 的 6 张预览从 78 秒压到约 10 秒、成本从 ¥1.2 压到 ¥0.12，
 * 这是量级差异而非优化。
 *
 * 与 Volcengine 实现的三处形态差异（不是风格问题，是 API 本身不同）：
 *   1. **同步返回**，没有 submit→poll 的异步任务；因此没有 task_id 可记账，
 *      `callId` 用响应 id 兜底，供成本追溯
 *   2. **multipart/form-data** 上传图片本体，而非传 URL 让供应商去抓
 *      → 意味着不需要预签名 URL，也就少一层暴露面
 *   3. 返回 **base64** 而非图片 URL（`response_format: b64_json`）
 *
 * ⚠ 尚未用真实凭证验证过。`STEPFUN_API_KEY` 未配置时构造即抛错，
 * 不会静默降级成一个永远失败的 provider。
 */

const MODEL_ID = process.env.STEPFUN_IMAGE_EDIT_MODEL ?? "step-image-edit-2";
const ENDPOINT = process.env.STEPFUN_BASE_URL ?? "https://api.stepfun.com/v1";

/** 官方示例给的默认值；steps 越低越快，8 是示例值 */
const DEFAULT_CFG_SCALE = 1.0;
const DEFAULT_STEPS = 8;

type StepFunEditResponse = {
  id?: string;
  created?: number;
  data?: { b64_json?: string; url?: string }[];
  error?: { message?: string; type?: string };
};

export function createStepFunImageEditProvider(): ImageEditProvider {
  const apiKey = required("STEPFUN_API_KEY");

  return {
    name: "stepfun-image-edit-2",

    async edit(input: ImageEditInput): Promise<ImageEditResult> {
      const start = Date.now();

      // 图片本体必须以 multipart 上传。调用方给 URL 时先取回字节——
      // 多一次拉取，但换来的是不必给供应商签发预签名 URL（少一层暴露面）
      let imageBytes: Buffer;
      if (input.imageBase64) {
        imageBytes = Buffer.from(input.imageBase64, "base64");
      } else if (input.imageUrl) {
        const res = await fetch(input.imageUrl);
        if (!res.ok) throw new Error(`拉取输入图失败 (${res.status}): ${input.imageUrl.slice(0, 80)}`);
        imageBytes = Buffer.from(await res.arrayBuffer());
      } else {
        throw new Error("stepfun-image-edit 需要 imageBase64 或 imageUrl 之一");
      }

      const form = new FormData();
      form.append("model", MODEL_ID);
      form.append("image", new Blob([new Uint8Array(imageBytes)], { type: "image/jpeg" }), "input.jpg");
      form.append("prompt", input.instruction);
      form.append("response_format", "b64_json");
      form.append("cfg_scale", String(DEFAULT_CFG_SCALE));
      form.append("steps", String(DEFAULT_STEPS));

      const res = await fetch(`${ENDPOINT}/images/edits`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });

      const json = (await res.json()) as StepFunEditResponse;
      if (!res.ok || json.error) {
        throw new Error(`StepFun 图像编辑失败 (${res.status}): ${json.error?.message ?? JSON.stringify(json).slice(0, 200)}`);
      }

      const b64 = json.data?.[0]?.b64_json;
      const url = json.data?.[0]?.url;
      if (!b64 && !url) {
        throw new Error(`StepFun 未返回图片内容: ${JSON.stringify(json).slice(0, 200)}`);
      }

      return {
        provider: "stepfun-image-edit-2",
        imageUrl: url,
        imageBase64: b64,
        // 同步 API 没有 task_id；用响应 id 兜底以便成本追溯与问题定位
        callId: json.id,
        latencyMs: Date.now() - start,
        raw: { id: json.id, created: json.created },
      };
    },
  };
}

/** 供 provider 选型对比脚本使用的公开参数（来自官方文档，未经我们实测） */
export const STEPFUN_CLAIMED_SPECS = {
  latencySeconds: "0.5-2",
  pricePerImageCNY: 0.02,
  concurrencyLimit: "未公开（火山为账号级并发=1，这是接入 StepFun 的主要动因）",
  syncApi: true,
} as const;
