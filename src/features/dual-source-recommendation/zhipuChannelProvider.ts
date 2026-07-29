import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import { z } from "zod";
import { env, required } from "../../config/env.js";
import { recordActiveProviderOperation, usageFromProviderResult } from "../../services/providerOperationMeter.js";
import type { DualSourceProviderRequest, RawProviderResponse } from "./providerAdapter.js";

const OUTPUT_SCHEMA = z.object({
  candidates: z.array(z.object({
    nameZh: z.string().min(1).max(80),
    rationale: z.string().min(1).max(500),
    hardConflict: z.boolean().optional(),
  }).strict()).min(1).max(12),
}).strict();

const SAFETY = [
  "只从造型可行性角度描述，不做医学诊断、外貌贬损、年龄数字或性别倾向判断。",
  "客户端几何结论是权威输入；不要根据照片重新判断脸型或几何比例。",
  "每条理由都要绑定结构化输入里的具体信号和数值；如果信号稳定度低、不可用或相互冲突，要明确说明局限，而非补猜。",
  "不要建议改变骨骼、五官、体型、身份、背景或任何非造型属性。",
  "仅返回候选名称和简短的造型可行性理由。",
].join("\n");

/** Exported for a contract test: A must be unable to infer catalog size/content. */
export function buildDualSourceProviderPrompt(request: DualSourceProviderRequest): string {
  const base = [
    `你正在为 BetterMeet 生成${request.domain}推荐，必须调用 submit_recommendations 工具。`,
    SAFETY,
    `【用户已选上游结果】${JSON.stringify(request.commonInput.selectedUpstream)}`,
    `【已授权用户结构化信息】${JSON.stringify(request.commonInput.userContext ?? {})}`,
  ];
  if (request.domain === "wardrobe"
    && (request.commonInput.userContext as { visualBodyEvidence?: unknown } | undefined)?.visualBodyEvidence === "missing") {
    // Measurements and self-reports remain useful structured inputs, but a
    // missing full-body original means neither A nor B may imply it visually
    // observed proportions. This is a user-visible truthfulness boundary, not
    // a ranking preference, so it belongs in their shared base prompt.
    base.push("没有全身照：可依据用户自报尺寸和偏好给出穿搭结构建议，但不得声称观察到身材比例，也不得承诺或请求本人换装预览。");
  }
  if (request.channel === "B") {
    base.push(
      `【系统候选投影】${JSON.stringify(request.systemContext?.candidates.map((row) => ({
        id: row.stableId,
        nameZh: row.candidate.nameZh,
        rationale: row.candidate.rationale,
        projection: row.projection,
      })) ?? [])}`,
      `【系统规则投影】${JSON.stringify(request.systemContext?.rules ?? [])}`,
      "B 通道只能从系统候选投影中选择候选名称，不得创造未列出的系统 ID。",
    );
  }
  return base.join("\n");
}

export function createZhipuDualSourceChannelProvider(options: {
  /** Short-lived URLs are execution-only and never enter comparison persistence. */
  originalPhotoReadUrls: readonly string[];
  modelId?: string;
  modelVersion?: string;
  invoke?: (input: { prompt: string; photoReadUrls: readonly string[]; temperature: number; tokenLimit: number }) => Promise<RawProviderResponse>;
}) {
  const modelId = options.modelId ?? process.env.DUAL_SOURCE_RECOMMENDATION_MODEL ?? "glm-4.6v";
  const modelVersion = options.modelVersion ?? modelId;
  return async (request: DualSourceProviderRequest): Promise<RawProviderResponse> => {
    try {
      const prompt = buildDualSourceProviderPrompt(request);
      const result = options.invoke
        ? await options.invoke({
          prompt,
          photoReadUrls: options.originalPhotoReadUrls,
          temperature: request.commonInput.model.temperature,
          tokenLimit: request.commonInput.model.tokenLimit,
        })
        : await (async (): Promise<RawProviderResponse> => {
          const provider = createOpenAICompatible({
            name: "zhipu",
            apiKey: required("ZHIPU_API_KEY"),
            baseURL: env.zhipu.baseURL,
          });
          const startedAt = Date.now();
          const response = await generateText({
            model: provider(modelId),
            messages: [{
              role: "user",
              content: [
                { type: "text", text: prompt },
                ...options.originalPhotoReadUrls.map((image) => ({ type: "image" as const, image })),
              ],
            }],
            tools: {
              submit_recommendations: {
                description: "提交严格结构化的领域推荐候选。",
                inputSchema: OUTPUT_SCHEMA,
              },
            },
            toolChoice: "auto",
            temperature: request.commonInput.model.temperature,
            maxOutputTokens: request.commonInput.model.tokenLimit,
            providerOptions: { zhipu: { thinking: { type: "disabled" } } },
          });
          const call = response.toolCalls.find((item) => item.toolName === "submit_recommendations");
          if (!call) throw new Error("dual_source_schema_missing");
          const output = OUTPUT_SCHEMA.parse(call.input);
          return {
            candidates: output.candidates,
            provider: "zhipu",
            model: modelId,
            modelVersion,
            latencyMs: Date.now() - startedAt,
            callId: response.response.id,
            usage: response.usage,
          };
        })();
      await recordActiveProviderOperation({
        provider: "zhipu",
        operation: "dual_source_recommendation",
        model: modelId,
        status: "completed",
        providerCallId: result.callId,
        usage: usageFromProviderResult(result),
      });
      return result;
    } catch (error) {
      await recordActiveProviderOperation({
        provider: "zhipu",
        operation: "dual_source_recommendation",
        model: modelId,
        status: "failed",
        usage: { apiRequestCount: 1 },
      });
      throw error;
    }
  };
}
