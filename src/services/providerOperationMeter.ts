import type { ProviderOperationUsage } from "./providerCostAccounting.js";
import { recordProviderOperation, type ProviderOperationRecord } from "./providerCostAccounting.js";

type AccountingPrisma = Parameters<typeof recordProviderOperation>[0];

export type ProviderOperationRecorder = {
  record(record: ProviderOperationRecord): Promise<void>;
};

const noopRecorder: ProviderOperationRecorder = { record: async () => {} };
let activeRecorder: ProviderOperationRecorder = noopRecorder;

export function setActiveProviderOperationRecorder(recorder: ProviderOperationRecorder): void {
  activeRecorder = recorder;
}

export function createPrismaProviderOperationRecorder(prisma: AccountingPrisma): ProviderOperationRecorder {
  return { record: (record) => recordProviderOperation(prisma, record) };
}

export function recordActiveProviderOperation(record: ProviderOperationRecord): Promise<void> {
  return activeRecorder.record(record);
}

type UsageBearingResult = {
  imageUrl?: string;
  imageBase64?: string;
  callId?: string;
  usage?: unknown;
  raw?: unknown;
};

function numberAt(value: unknown, names: string[]): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const data = value as Record<string, unknown>;
  for (const name of names) {
    if (typeof data[name] === "number" && Number.isFinite(data[name])) return data[name] as number;
  }
  return undefined;
}

export function usageFromProviderResult(result: UsageBearingResult): ProviderOperationUsage {
  const rawUsage = result.usage ?? (result.raw && typeof result.raw === "object" ? (result.raw as Record<string, unknown>).usage : undefined);
  const inputTokens = numberAt(rawUsage, ["inputTokens", "input_tokens", "promptTokens", "prompt_tokens"]);
  const outputTokens = numberAt(rawUsage, ["outputTokens", "output_tokens", "completionTokens", "completion_tokens"]);
  const cached = numberAt(rawUsage, ["cacheHitInputTokens", "cache_hit_input_tokens", "cached_tokens", "cacheReadTokens"])
    ?? numberAt(rawUsage && typeof rawUsage === "object" ? (rawUsage as Record<string, unknown>).inputTokenDetails : undefined, ["cacheReadTokens", "cached_tokens"]);
  const explicitUncached = numberAt(rawUsage, ["cacheMissInputTokens", "cache_miss_input_tokens", "noCacheTokens"])
    ?? numberAt(rawUsage && typeof rawUsage === "object" ? (rawUsage as Record<string, unknown>).inputTokenDetails : undefined, ["noCacheTokens"]);
  // AI SDKs that omit cache details report total input tokens. Treat it as a cache miss
  // instead of publishing a deceptively known $0 prompt cost.
  const uncached = explicitUncached ?? (inputTokens === undefined ? undefined : Math.max(0, inputTokens - (cached ?? 0)));
  const generatedImageCount = result.imageUrl || result.imageBase64
    ? 1
    : numberAt(result.raw && typeof result.raw === "object" ? result.raw : undefined, ["generatedImageCount"]);
  return {
    apiRequestCount: 1,
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cached === undefined ? {} : { cacheHitInputTokens: cached }),
    ...(uncached === undefined ? {} : { cacheMissInputTokens: uncached }),
    ...(generatedImageCount === undefined ? {} : { generatedImageCount }),
  };
}

/**
 * Decorates the existing provider-operation seam. It deliberately leaves all other
 * provider members untouched, so adapters can be swapped without changing workflow code.
 */
export function meterProviderMethod<T extends object>(
  provider: T,
  details: { provider: string; operation: string; model?: string; method: string },
): T {
  return new Proxy(provider, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== details.method || typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        try {
          const result = await value.apply(target, args) as UsageBearingResult;
          await activeRecorder.record({
            provider: details.provider,
            operation: details.operation,
            model: details.model,
            status: "completed",
            usage: usageFromProviderResult(result),
            providerCallId: result.callId,
          });
          return result;
        } catch (error) {
          await activeRecorder.record({
            provider: details.provider,
            operation: details.operation,
            model: details.model,
            status: "failed",
            usage: { apiRequestCount: 1 },
          });
          throw error;
        }
      };
    },
  });
}
