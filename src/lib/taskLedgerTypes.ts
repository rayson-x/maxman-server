/**
 * Task ledger 契约（tasks 10.4）。
 *
 * 目的不变：供应商异步调用在**提交后立刻落盘**，这样即使调用方崩溃/断线，
 * 也能凭 callId 恢复轮询而不是重新提交（避免重复计费）。
 *
 * 抽出接口是为了让存储后端可替换而**调用方零改动**：
 *   - 文件版（`createFileTaskLedger`）：测试脚本用，无需数据库
 *   - Postgres 版（`createPrismaTaskLedger`）：应用运行时用，可跨进程/跨重启
 *
 * 为什么不让 signedRequest 直接 import 全局 prisma 单例：那会让所有 provider
 * 硬依赖数据库，测试脚本必须起 Postgres 才能跑一次图片生成。ledger 作为可注入
 * 依赖，默认落文件、应用装配时注入 Postgres 版，两边都自然。
 */

export type TaskStatus = "submitted" | "polling" | "done" | "failed";

export interface TaskLedgerEntry {
  callId: string;
  provider: string;
  reqKey: string;
  purpose?: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  requestSummary?: Record<string, unknown>;
  resultUrls?: string[];
  error?: string;
}

export interface TaskLedger {
  recordSubmitted(params: {
    callId: string;
    provider: string;
    reqKey: string;
    purpose?: string;
    requestBody?: Record<string, unknown>;
  }): Promise<void>;
  recordProgress(callId: string, status: TaskStatus): Promise<void>;
  recordResult(callId: string, result: { status: TaskStatus; resultUrls?: string[]; error?: string }): Promise<void>;
  getEntry(callId: string): Promise<TaskLedgerEntry | undefined>;
  listPending(): Promise<TaskLedgerEntry[]>;
}

const MAX_INLINE_LENGTH = 500;

/** 请求摘要脱敏：base64 图片等长字段不落盘，只记长度 */
export function redactRequestBody(body: Record<string, unknown>): Record<string, unknown> {
  const redact = (value: unknown): unknown => {
    if (typeof value === "string" && value.length > MAX_INLINE_LENGTH) {
      return `<omitted, length=${value.length}>`;
    }
    if (Array.isArray(value)) return value.map(redact);
    return value;
  };
  return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, redact(v)]));
}
