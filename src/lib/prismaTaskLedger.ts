import type { PrismaClient } from "../generated/prisma/client.js";
import { redactRequestBody, type TaskLedger, type TaskLedgerEntry, type TaskStatus } from "./taskLedgerTypes.js";
import { recordProviderOperation } from "../services/providerCostAccounting.js";

function accountingOperation(purpose: string | undefined): "clothing_swap" | "image_edit" | undefined {
  if (purpose === "clothing-swap") return "clothing_swap";
  if (purpose === "image-edit") return "image_edit";
  return undefined;
}

/**
 * Postgres 版 task ledger（tasks 10.4）。
 *
 * 相对文件版的实质改进不是"更正规"，而是**跨进程可见**：
 * API 进程提交的任务，worker 进程能查到；一个 worker 崩了，另一个能凭 callId 接管轮询。
 * 文件版在多进程部署下各写各的文件，恢复能力形同虚设。
 */
export function createPrismaTaskLedger(prisma: PrismaClient): TaskLedger {
  const toEntry = (row: {
    callId: string | null;
    providerRequestKey: string | null;
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
    callId: row.callId ?? undefined,
    providerRequestKey: row.providerRequestKey ?? undefined,
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
    async recordPrepared(params) {
      // 提交之前落盘。此后若崩溃，恢复流程能看到「我们打算调用过」，
      // 而不是完全无记录——那时无从判断是否已计费。
      await prisma.providerCallLog.upsert({
        where: { providerRequestKey: params.providerRequestKey },
        create: {
          providerRequestKey: params.providerRequestKey,
          provider: params.provider,
          reqKey: params.reqKey,
          purpose: params.purpose,
          status: "prepared",
          costEstimate: params.costEstimate,
          requestSummary: (params.requestBody ? redactRequestBody(params.requestBody) : undefined) as never,
        },
        update: { status: "prepared", purpose: params.purpose },
      });
    },

    async sweepStale(olderThanMs) {
      const cutoff = new Date(Date.now() - olderThanMs);
      const r = await prisma.providerCallLog.updateMany({
        where: { status: { in: ["prepared", "submitted", "polling"] }, updatedAt: { lt: cutoff } },
        data: { status: "unknown", error: "状态不可知：超过期限未收到结果，需人工对账" },
      });
      await prisma.providerOperationUsage.updateMany({
        where: { providerCallId: { in: (await prisma.providerCallLog.findMany({ where: { status: "unknown", updatedAt: { gte: cutoff } }, select: { callId: true } })).flatMap((row) => row.callId ? [row.callId] : []) } },
        data: { status: "unknown" },
      });
      return r.count;
    },

    async recordSubmitted(params) {
      // upsert 而非 create：同一 callId 重复提交（例如重试后拿到同一个 task_id）
      // 不该炸掉调用方——记账的目的是不丢，不是强制唯一性检查
      // 有 prepared 记录时关联到它，而不是另起一行——否则一次调用留下两条账
      if (params.providerRequestKey) {
        const linked = await prisma.providerCallLog.updateMany({
          where: { providerRequestKey: params.providerRequestKey },
          data: { callId: params.callId, status: "submitted", purpose: params.purpose },
        });
        if (linked.count > 0) {
          const operation = accountingOperation(params.purpose);
          if (operation) await recordProviderOperation(prisma, {
            provider: params.provider,
            operation,
            model: params.reqKey,
            status: "completed",
            providerCallId: params.callId,
            usage: { acceptedTaskCount: 1 },
          });
          return;
        }
      }
      await prisma.providerCallLog.upsert({
        where: { callId: params.callId },
        create: {
          callId: params.callId,
          providerRequestKey: params.providerRequestKey,
          provider: params.provider,
          reqKey: params.reqKey,
          purpose: params.purpose,
          status: "submitted",
          requestSummary: (params.requestBody ? redactRequestBody(params.requestBody) : undefined) as never,
        },
        update: { status: "submitted", purpose: params.purpose },
      });
      const operation = accountingOperation(params.purpose);
      if (operation) await recordProviderOperation(prisma, {
        provider: params.provider,
        operation,
        model: params.reqKey,
        status: "completed",
        providerCallId: params.callId,
        usage: { acceptedTaskCount: 1 },
      });
    },

    async recordProgress(callId, status) {
      await prisma.providerCallLog.updateMany({ where: { callId }, data: { status } });
      await prisma.providerOperationUsage.updateMany({ where: { providerCallId: callId }, data: { status } });
    },

    async recordResult(callId, result) {
      await prisma.providerCallLog.updateMany({
        where: { callId },
        data: { status: result.status, resultUrls: result.resultUrls ?? [], error: result.error },
      });
      await prisma.providerOperationUsage.updateMany({ where: { providerCallId: callId }, data: { status: result.status } });
    },

    async getEntry(key) {
      // 两种键都接：prepared 阶段只有 providerRequestKey（callId 要提交成功才有）。
      // 文件版以 providerRequestKey 为键存 prepared，这里必须行为一致，
      // 否则「测试用文件版、生产用 PG 版」的前提就不成立。
      const row = await prisma.providerCallLog.findFirst({
        where: { OR: [{ callId: key }, { providerRequestKey: key }] },
      });
      return row ? toEntry(row) : undefined;
    },

    async listPending() {
      const rows = await prisma.providerCallLog.findMany({
        // prepared 不算 pending：它可能从未真正发出，恢复流程不该去轮询它
        where: { status: { in: ["submitted", "polling"] } },
        orderBy: { createdAt: "asc" },
      });
      return rows.map(toEntry);
    },
  };
}
