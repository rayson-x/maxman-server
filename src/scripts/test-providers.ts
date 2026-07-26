import "dotenv/config";
import { generateText } from "ai";
import { createDeepSeekModel } from "../features/appearance-agent/providers/llm/deepseekModel.js";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { env } from "../config/env.js";

/**
 * Connectivity smoke test: confirm each provider's API key/auth actually
 * works, using the cheapest possible call (plain text, no images yet).
 * Run: npm run test:providers
 */

type CheckResult = { name: string; ok: boolean; detail: string };

async function checkTextModel(name: string, model: Parameters<typeof generateText>[0]["model"]): Promise<CheckResult> {
  try {
    const { text } = await generateText({
      model,
      messages: [{ role: "user", content: "回复两个字：收到" }],
    });
    return { name, ok: true, detail: text.slice(0, 50) };
  } catch (err) {
    return { name, ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

async function main() {
  const results: CheckResult[] = [];

  // 1. DeepSeek (brain)
  results.push(await checkTextModel("DeepSeek (brain)", createDeepSeekModel()));

  // 2. Zhipu GLM (vision candidate, text-only smoke test here)
  if (env.zhipu.apiKey) {
    const zhipu = createOpenAICompatible({ name: "zhipu", apiKey: env.zhipu.apiKey, baseURL: env.zhipu.baseURL });
    results.push(await checkTextModel("Zhipu GLM-4V", zhipu("glm-4v-flash")));
  } else {
    results.push({ name: "Zhipu GLM-4V", ok: false, detail: "ZHIPU_API_KEY not set" });
  }

  // 3. Qwen via DashScope OpenAI-compatible mode
  if (env.aliyun.dashscopeApiKey && env.aliyun.openaiBaseURL) {
    const qwen = createOpenAICompatible({
      name: "qwen",
      apiKey: env.aliyun.dashscopeApiKey,
      baseURL: env.aliyun.openaiBaseURL,
    });
    results.push(await checkTextModel("Qwen-VL (DashScope)", qwen("qwen-vl-plus")));
  } else {
    results.push({ name: "Qwen-VL (DashScope)", ok: false, detail: "ALIYUN_DASHSCOPE_API_KEY/OPENAI_BASE_URL not set" });
  }

  // 4. Tencent Hunyuan
  if (env.hunyuan.apiKey) {
    const hunyuan = createOpenAICompatible({ name: "hunyuan", apiKey: env.hunyuan.apiKey, baseURL: env.hunyuan.baseURL });
    results.push(await checkTextModel("Hunyuan (text/vision)", hunyuan("hunyuan-lite")));
  } else {
    results.push({ name: "Hunyuan (text/vision)", ok: false, detail: "TENCENT_HUNYUAN_API_KEY not set" });
  }

  // 5. Volcengine signing sanity check (does not hit network — just confirms
  //    the Signer can be constructed and AK/SK are present; the real
  //    CVSync2AsyncSubmitTask call needs a confirmed req_key + test image).
  if (env.volc.accessKeyId && env.volc.secretAccessKey) {
    try {
      const { Signer } = await import("@volcengine/openapi");
      const requestData = {
        region: env.volc.region,
        method: "POST",
        params: { Action: "CVSync2AsyncSubmitTask", Version: "2022-08-31" },
        headers: { Host: env.volc.visualHost, "Content-Type": "application/json" },
        body: "{}",
      };
      const signer = new Signer(requestData, "cv");
      signer.addAuthorization({ accessKeyId: env.volc.accessKeyId, secretKey: env.volc.secretAccessKey });
      const hasAuthHeader = Boolean((requestData.headers as Record<string, string>).Authorization);
      results.push({
        name: "Volcengine (signer construction only)",
        ok: hasAuthHeader,
        detail: hasAuthHeader ? "signed headers produced" : "no Authorization header produced",
      });
    } catch (err) {
      results.push({
        name: "Volcengine (signer construction only)",
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    results.push({ name: "Volcengine", ok: false, detail: "VOLC_ACCESS_KEY_ID/SECRET not set" });
  }

  console.log("\n=== Provider connectivity results ===");
  for (const r of results) {
    console.log(`${r.ok ? "✅" : "❌"} ${r.name}: ${r.detail}`);
  }
}

main().catch((err) => {
  console.error("Fatal error running provider checks:", err);
  process.exit(1);
});
