import type { FastifyInstance } from "fastify";
import { QUEUE_NAMES, QUEUE_CONFIG } from "../lib/queues.js";

/**
 * 健康检查。刻意**真正打一次 DB 与 Redis**而不是只返回 200——
 * 只返回 200 的健康检查在依赖挂掉时依然报健康，等于没有。
 */
export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async (_req, reply) => {
    const checks: Record<string, { ok: boolean; detail?: string }> = {};

    try {
      await app.container.prisma.$queryRaw`SELECT 1`;
      checks.database = { ok: true };
    } catch (err) {
      checks.database = { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }

    try {
      const q = app.container.queues.queues[QUEUE_NAMES.imageGeneration];
      const counts = await q.getJobCounts("waiting", "active", "failed");
      checks.redis = { ok: true, detail: JSON.stringify(counts) };
    } catch (err) {
      checks.redis = { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }

    const allOk = Object.values(checks).every((c) => c.ok);
    return reply.code(allOk ? 200 : 503).send({
      status: allOk ? "ok" : "degraded",
      checks,
      // 把并发=1 这个供应商硬约束显式暴露出来，便于运维确认配置没被改坏
      imageGenerationConcurrency: QUEUE_CONFIG[QUEUE_NAMES.imageGeneration].concurrency,
    });
  });
}
