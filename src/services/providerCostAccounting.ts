export type PricingUnit =
  | "inputToken"
  | "outputToken"
  | "cacheHitInputToken"
  | "cacheMissInputToken"
  | "acceptedTask"
  | "generatedImage"
  | "apiRequest"
  | "putRequest"
  | "getRequest"
  | "deleteRequest"
  | "egressByte";

export type ProviderOperationUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheHitInputTokens?: number;
  cacheMissInputTokens?: number;
  acceptedTaskCount?: number;
  generatedImageCount?: number;
  apiRequestCount?: number;
  putRequestCount?: number;
  getRequestCount?: number;
  deleteRequestCount?: number;
  egressBytes?: number;
  /** HTTP requests are diagnostic-only unless a rule explicitly prices API requests. */
  transportRequestCount?: number;
};

export type PricingRule = {
  id: string;
  provider: string;
  operation: string;
  model?: string;
  version: number;
  currency: string;
  unitPrices: Partial<Record<PricingUnit, number>>;
  effectiveAt: Date;
  costState?: "known" | "unknown";
};

export type PricingRuleLookup = {
  provider: string;
  operation: string;
  model?: string;
  occurredAt: Date;
};

export function matchPricingRule(rules: PricingRule[], lookup: PricingRuleLookup): PricingRule | undefined {
  return rules
    .filter((rule) =>
      rule.provider === lookup.provider &&
      (rule.operation === lookup.operation || rule.operation === "*") &&
      (rule.model === undefined || rule.model === lookup.model) &&
      rule.effectiveAt <= lookup.occurredAt,
    )
    .sort((a, b) => b.effectiveAt.getTime() - a.effectiveAt.getTime() || b.version - a.version)[0];
}

const usageByUnit: Record<PricingUnit, keyof ProviderOperationUsage> = {
  inputToken: "inputTokens",
  outputToken: "outputTokens",
  cacheHitInputToken: "cacheHitInputTokens",
  cacheMissInputToken: "cacheMissInputTokens",
  acceptedTask: "acceptedTaskCount",
  generatedImage: "generatedImageCount",
  apiRequest: "apiRequestCount",
  putRequest: "putRequestCount",
  getRequest: "getRequestCount",
  deleteRequest: "deleteRequestCount",
  egressByte: "egressBytes",
};

export type CostCalculation =
  | { state: "known"; currency: string; amount: number }
  | { state: "unknown" };

export function calculateProviderOperationCost(
  rule: PricingRule | undefined,
  usage: ProviderOperationUsage,
): CostCalculation {
  if (!rule) return { state: "unknown" };
  if (rule.costState === "unknown") return { state: "unknown" };

  const amount = Object.entries(rule.unitPrices).reduce((total, [unit, price]) => {
    const usageKey = usageByUnit[unit as PricingUnit];
    return total + (usage[usageKey] ?? 0) * (price ?? 0);
  }, 0);
  return { state: "known", currency: rule.currency, amount };
}

type AccountingPrisma = {
  providerPricingRule: {
    findMany(args: unknown): Promise<Array<{
      id: string; provider: string; operation: string; model: string; version: number; costState: string;
      currency: string | null; unitPrices: unknown; effectiveAt: Date;
    }>>;
    upsert(args: unknown): Promise<unknown>;
  };
  providerOperationUsage: {
    upsert(args: unknown): Promise<unknown>;
    create(args: unknown): Promise<unknown>;
  };
};

export type ProviderOperationRecord = {
  provider: string;
  operation: string;
  model?: string;
  status: "completed" | "failed" | "unknown";
  usage: ProviderOperationUsage;
  providerCallId?: string;
  sourceUsage?: Record<string, unknown>;
  occurredAt?: Date;
};

function asUnitPrices(value: unknown): Partial<Record<PricingUnit, number>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [PricingUnit, number] =>
      typeof entry[1] === "number" && Number.isFinite(entry[1]),
    ),
  );
}

function toRule(row: Awaited<ReturnType<AccountingPrisma["providerPricingRule"]["findMany"]>>[number]): PricingRule {
  return {
    id: row.id,
    provider: row.provider,
    operation: row.operation,
    model: row.model === "*" ? undefined : row.model,
    version: row.version,
    costState: row.costState === "unknown" ? "unknown" : "known",
    currency: row.currency ?? "CNY",
    unitPrices: asUnitPrices(row.unitPrices),
    effectiveAt: row.effectiveAt,
  };
}

/** Persist one business operation. Existing async provider task ids make this idempotent. */
export async function recordProviderOperation(prisma: AccountingPrisma, record: ProviderOperationRecord): Promise<void> {
  const occurredAt = record.occurredAt ?? new Date();
  const rows = await prisma.providerPricingRule.findMany({
    where: {
      provider: record.provider,
      operation: { in: [record.operation, "*"] },
      model: { in: [record.model ?? "", "*"] },
      effectiveAt: { lte: occurredAt },
    },
  });
  const rule = matchPricingRule(rows.map(toRule), { ...record, occurredAt });
  const cost = calculateProviderOperationCost(rule, record.usage);
  const data = {
    provider: record.provider,
    operation: record.operation,
    model: record.model,
    status: record.status,
    providerCallId: record.providerCallId,
    pricingRuleId: rule?.id,
    pricingRuleVersion: rule?.version,
    costState: cost.state,
    estimatedCost: cost.state === "known" ? cost.amount : null,
    currency: cost.state === "known" ? cost.currency : null,
    usage: record.usage,
    sourceUsage: record.sourceUsage,
    occurredAt,
    completedAt: record.status === "completed" ? occurredAt : null,
  };
  if (record.providerCallId) {
    await prisma.providerOperationUsage.upsert({
      where: { provider_providerCallId: { provider: record.provider, providerCallId: record.providerCallId } },
      create: data,
      // The first accepted call owns its price snapshot; an idempotent retry must not reprice history.
      update: {},
    });
  } else {
    await prisma.providerOperationUsage.create({ data });
  }
}

export type ProviderCostAggregationRow = {
  provider: string;
  operation: string;
  model: string | null;
  costState: string;
  estimatedCost: number | null;
  currency: string | null;
  usage: unknown;
};

export function aggregateProviderCostRows(rows: ProviderCostAggregationRow[]) {
  const buckets = new Map<string, {
    provider: string; operation: string; model: string | null; currency: string | null;
    operationCount: number; knownCost: number; unknownCostOperationCount: number; usage: ProviderOperationUsage;
  }>();
  for (const row of rows) {
    const key = [row.provider, row.operation, row.model ?? "", row.currency ?? ""].join("\u0000");
    const bucket = buckets.get(key) ?? {
      provider: row.provider, operation: row.operation, model: row.model, currency: row.currency,
      operationCount: 0, knownCost: 0, unknownCostOperationCount: 0, usage: {},
    };
    bucket.operationCount += 1;
    if (row.costState === "known") bucket.knownCost += row.estimatedCost ?? 0;
    else bucket.unknownCostOperationCount += 1;
    for (const [name, value] of Object.entries(row.usage ?? {})) {
      if (typeof value === "number" && Number.isFinite(value)) {
        const usageKey = name as keyof ProviderOperationUsage;
        bucket.usage[usageKey] = (bucket.usage[usageKey] ?? 0) + value;
      }
    }
    buckets.set(key, bucket);
  }
  return [...buckets.values()];
}
