import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

import { env } from "../config/env.js";
import { registerProviderCostRoutes } from "./providerCosts.js";

test("provider-cost aggregation requires its admin token and separates known from unknown usage", async (t) => {
  const previousToken = env.server.adminCostApiToken;
  (env.server as { adminCostApiToken?: string }).adminCostApiToken = "cost-test-token";
  t.after(() => { (env.server as { adminCostApiToken?: string }).adminCostApiToken = previousToken; });

  const app = Fastify();
  app.decorate("container", {
    prisma: {
      providerOperationUsage: {
        findMany: async () => [
          { provider: "deepseek", operation: "text_planning", model: "deepseek-v4-flash", costState: "known", estimatedCost: 0.00005, currency: "USD", usage: { inputTokens: 100, outputTokens: 10 } },
          { provider: "open-meteo", operation: "geocoding", model: null, costState: "unknown", estimatedCost: null, currency: null, usage: { apiRequestCount: 1 } },
        ],
      },
    },
  } as never);
  await registerProviderCostRoutes(app);
  t.after(() => app.close());

  const forbidden = await app.inject({ method: "GET", url: "/internal/provider-costs" });
  assert.equal(forbidden.statusCode, 403);

  const response = await app.inject({
    method: "GET",
    url: "/internal/provider-costs",
    headers: { "x-admin-cost-token": "cost-test-token" },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    groups: [
      {
        provider: "deepseek",
        operation: "text_planning",
        model: "deepseek-v4-flash",
        currency: "USD",
        operationCount: 1,
        knownCost: 0.00005,
        unknownCostOperationCount: 0,
        usage: { inputTokens: 100, outputTokens: 10 },
      },
      {
        provider: "open-meteo",
        operation: "geocoding",
        model: null,
        currency: null,
        operationCount: 1,
        knownCost: 0,
        unknownCostOperationCount: 1,
        usage: { apiRequestCount: 1 },
      },
    ],
  });
});
