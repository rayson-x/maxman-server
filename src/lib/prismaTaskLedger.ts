import type { PrismaClient } from "../generated/prisma/client.js";
import { redactRequestBody, type TaskLedger, type TaskLedgerEntry, type TaskStatus } from "./taskLedgerTypes.js";

/**
 * Postgres 版 task ledger（tasks 10.4）。
 *
 * 相对文件版的实质改进不是"更正规"，而是**跨进程可见**：
 * API 进程提交的任务，worker 进程能查到；一个 worker 崩了，另一个能凭 callId 接管轮询。
 * 文件版在多进程部署下各写各的文件，恢复能力形同虚设。
 */
export function createPrismaTaskLedger(prisma: PrismaClient): TaskLedger {
  const toEntry = (row: {
    callId: string;
    provider: string;
    reqKey: string;
    purpose: string | null;
    status: string;
    createdAt: Date;
    updatedAt: Date;
    requestSummary: unknown;
    resultUrls: string[];
    error: string | null;
  }): TaskLedgerEntry => ({
    callId: row.callId,
    provider: row.provider,
    reqKey: row.reqKey,
    purpose: row.purpose ?? undefined,
    status: row.status as TaskStatus,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    requestSummary: (row.requestSummary ?? undefined) as Record<string, unknown> | undefined,
    resultUrls: row.resultUrls,
    error: row.error ?? undefined,
  });

  return {
    async recordSubmitted(params) {
      // upsert 而非 create：同一 callId 重复提交（例如重试后拿到同一个 task_id）
      // 不该炸掉调用方——记账的目的是不丢，不是强制唯一性检查
      await prisma.providerCallLog.upsert({
        where: { callId: params.callId },
        create: {
          callId: params.callId,
          provider: params.provider,
          reqKey: params.reqKey,
          purpose: params.purpose,
          status: "submitted",
          requestSummary: (params.requestBody ? redactRequestBody(params.requestBody) : undefined) as never,
        },
        update: { status: "submitted", purpose: params.purpose },
      });
    },

    async recordProgress(callId, status) {
      await prisma.providerCallLog.updateMany({ where: { callId }, data: { status } });
    },

    async recordResult(callId, result) {
      await prisma.providerCallLog.updateMany({
        where: { callId },
        data: { status: result.status, resultUrls: result.resultUrls ?? [], error: result.error },
      });
    },

    async getEntry(callId) {
      const row = await prisma.providerCallLog.findUnique({ where: { callId } });
      return row ? toEntry(row) : undefined;
    },

    async listPending() {
      const rows = await prisma.providerCallLog.findMany({
        where: { status: { in: ["submitted", "polling"] } },
        orderBy: { createdAt: "asc" },
      });
      return rows.map(toEntry);
    },
  };
}
