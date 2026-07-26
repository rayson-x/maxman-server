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

/**
 * `prepared` 在提交供应商**之前**写入；`unknown` 是终态。
 *
 * 为什么需要 `unknown`：存在无法消除的崩溃窗口——写完 prepared、HTTP 已被供应商接受、
 * 记录结果之前进程崩溃。恢复时库里是 prepared，而供应商可能已经计费。
 * 火山的 CVSync2AsyncSubmitTask 不接受客户端幂等键、也没有按客户端键查询的接口，
 * 所以只能承认不可知：过期的 prepared 转 unknown，**不自动重提**，走人工对账。
 * 把它记成 failed 会让恢复流程重复提交，那才是真的重复付费。
 */
export type TaskStatus = "prepared" | "submitted" | "polling" | "done" | "failed" | "unknown";

export interface TaskLedgerEntry {
  /** prepared 阶段为空——供应商 task_id 要提交成功才知道 */
  callId?: string;
  /** 我们提交前生成的请求键，prepared 记录靠它定位 */
  providerRequestKey?: string;
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
  /** 提交供应商**之前**调用。返回的请求键用于随后关联 callId */
  recordPrepared(params: {
    providerRequestKey: string;
    provider: string;
    reqKey: string;
    purpose?: string;
    requestBody?: Record<string, unknown>;
    costEstimate?: number;
  }): Promise<void>;
  /** 把过期的 prepared/submitted 转为 unknown 终态。返回受影响条数 */
  sweepStale(olderThanMs: number): Promise<number>;
  recordSubmitted(params: {
    /** 有值时关联到既有的 prepared 记录 */
    providerRequestKey?: string;
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
