import type { FastifyInstance } from "fastify";
import { env } from "../config/env.js";
import { aggregateProviderCostRows } from "../services/providerCostAccounting.js";

type CostQuery = { from?: string; to?: string; provider?: string; model?: string; operation?: string };

function requireCostAdmin(app: FastifyInstance, token: string | undefined): void {
  if (!token) {
    const error = new Error("provider cost aggregation is disabled") as Error & { statusCode?: number };
    error.statusCode = 404;
    throw error;
  }
  // Fastify's handler binding supplies request in the route below; this helper only documents the gate shape.
}

export async function registerProviderCostRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: CostQuery }>("/internal/provider-costs", async (req) => {
    const token = env.server.adminCostApiToken;
    requireCostAdmin(app, token);
    if (req.headers["x-admin-cost-token"] !== token) {
      const error = new Error("invalid admin cost token") as Error & { statusCode?: number };
      error.statusCode = 403;
      throw error;
    }
    const from = req.query.from ? new Date(req.query.from) : undefined;
    const to = req.query.to ? new Date(req.query.to) : undefined;
    if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime()))) {
      const error = new Error("from and to must be ISO dates") as Error & { statusCode?: number };
      error.statusCode = 400;
      throw error;
    }
    const rows = await app.container.prisma.providerOperationUsage.findMany({
      where: {
        ...(req.query.provider ? { provider: req.query.provider } : {}),
        ...(req.query.model ? { model: req.query.model } : {}),
        ...(req.query.operation ? { operation: req.query.operation } : {}),
        ...((from || to) ? { occurredAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      },
      select: { provider: true, operation: true, model: true, costState: true, estimatedCost: true, currency: true, usage: true },
      orderBy: { occurredAt: "asc" },
    });
    return { groups: aggregateProviderCostRows(rows) };
  });
}
