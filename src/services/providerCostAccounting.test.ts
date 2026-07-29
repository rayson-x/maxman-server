import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateProviderOperationCost,
  aggregateProviderCostRows,
  matchPricingRule,
  type PricingRule,
  type ProviderOperationUsage,
} from "./providerCostAccounting.js";

const dressingRule: PricingRule = {
  id: "volc-dressing-v1",
  provider: "volcengine-visual",
  operation: "clothing_swap",
  model: "dressing_diffusion",
  version: 1,
  currency: "CNY",
  unitPrices: { acceptedTask: 1 },
  effectiveAt: new Date("2026-07-29T00:00:00.000Z"),
};

test("clothing swap uses one accepted task rather than its poll request count", () => {
  const usage: ProviderOperationUsage = {
    acceptedTaskCount: 1,
    transportRequestCount: 6,
  };

  const rule = matchPricingRule([dressingRule], {
    provider: "volcengine-visual",
    operation: "clothing_swap",
    model: "dressing_diffusion",
    occurredAt: new Date("2026-07-29T12:00:00.000Z"),
  });

  assert.equal(rule?.id, "volc-dressing-v1");
  assert.deepEqual(calculateProviderOperationCost(rule, usage), {
    state: "known",
    currency: "CNY",
    amount: 1,
  });
});

test("unpriced model usage remains unknown instead of zero", () => {
  assert.deepEqual(
    calculateProviderOperationCost(undefined, { inputTokens: 1200, outputTokens: 80 }),
    { state: "unknown" },
  );
});

test("a newer rule does not match calls before its effective time", () => {
  const newerRule: PricingRule = { ...dressingRule, id: "volc-dressing-v2", version: 2, unitPrices: { acceptedTask: 0.8 }, effectiveAt: new Date("2026-08-01T00:00:00.000Z") };
  const selected = matchPricingRule([dressingRule, newerRule], {
    provider: "volcengine-visual",
    operation: "clothing_swap",
    model: "dressing_diffusion",
    occurredAt: new Date("2026-07-30T00:00:00.000Z"),
  });

  assert.equal(selected?.id, "volc-dressing-v1");
});

test("aggregation keeps unknown-cost usage out of known totals", () => {
  assert.deepEqual(aggregateProviderCostRows([
    { provider: "volcengine", operation: "clothing_swap", model: "dressing_diffusion", costState: "known", estimatedCost: 1, currency: "CNY", usage: { acceptedTaskCount: 1 } },
    { provider: "volcengine", operation: "image_edit", model: "seededit_v3.0", costState: "unknown", estimatedCost: null, currency: null, usage: { acceptedTaskCount: 1 } },
  ]), [
    { provider: "volcengine", operation: "clothing_swap", model: "dressing_diffusion", currency: "CNY", operationCount: 1, knownCost: 1, unknownCostOperationCount: 0, usage: { acceptedTaskCount: 1 } },
    { provider: "volcengine", operation: "image_edit", model: "seededit_v3.0", currency: null, operationCount: 1, knownCost: 0, unknownCostOperationCount: 1, usage: { acceptedTaskCount: 1 } },
  ]);
});
