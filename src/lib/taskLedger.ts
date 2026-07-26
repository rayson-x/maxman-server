import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { redactRequestBody, type TaskLedger, type TaskLedgerEntry } from "./taskLedgerTypes.js";

/**
 * 文件版 task ledger。
 *
 * 保留它的理由：测试脚本要能在**不起数据库**的前提下跑一次真实的图片生成。
 * 应用运行时用的是 Postgres 版（`createPrismaTaskLedger`），跨进程可见。
 *
 * 单进程读-改-写在当前脚本级调用量下够用；多进程场景请用 Postgres 版。
 */

const LEDGER_DIR = "data";
const LEDGER_FILE = `${LEDGER_DIR}/task-ledger.json`;

type LedgerFile = Record<string, TaskLedgerEntry>;

async function readLedger(): Promise<LedgerFile> {
  if (!existsSync(LEDGER_FILE)) return {};
  const raw = await readFile(LEDGER_FILE, "utf-8");
  return raw.trim() ? JSON.parse(raw) : {};
}

async function writeLedger(data: LedgerFile): Promise<void> {
  await mkdir(LEDGER_DIR, { recursive: true });
  await writeFile(LEDGER_FILE, JSON.stringify(data, null, 2));
}

export function createFileTaskLedger(): TaskLedger {
  return {
    async recordPrepared(params) {
      const ledger = await readLedger();
      const now = new Date().toISOString();
      // 文件版以 providerRequestKey 为键存 prepared：此时还没有 callId
      ledger[params.providerRequestKey] = {
        providerRequestKey: params.providerRequestKey,
        provider: params.provider,
        reqKey: params.reqKey,
        purpose: params.purpose,
        status: "prepared",
        createdAt: now,
        updatedAt: now,
        requestSummary: params.requestBody ? redactRequestBody(params.requestBody) : undefined,
      };
      await writeLedger(ledger);
    },

    async sweepStale(olderThanMs) {
      const ledger = await readLedger();
      const cutoff = Date.now() - olderThanMs;
      let count = 0;
      for (const entry of Object.values(ledger)) {
        if (!["prepared", "submitted", "polling"].includes(entry.status)) continue;
        if (new Date(entry.updatedAt).getTime() >= cutoff) continue;
        entry.status = "unknown";
        entry.error = "状态不可知：超过期限未收到结果，需人工对账";
        entry.updatedAt = new Date().toISOString();
        count += 1;
      }
      if (count > 0) await writeLedger(ledger);
      return count;
    },

    async recordSubmitted(params) {
      const ledger = await readLedger();
      const now = new Date().toISOString();
      // 有 prepared 记录时把它迁到 callId 键下，避免一次调用留两条账
      if (params.providerRequestKey && ledger[params.providerRequestKey]) {
        const prepared = ledger[params.providerRequestKey]!;
        delete ledger[params.providerRequestKey];
        ledger[params.callId] = {
          ...prepared,
          callId: params.callId,
          status: "submitted",
          purpose: params.purpose ?? prepared.purpose,
          updatedAt: now,
        };
        await writeLedger(ledger);
        return;
      }
      ledger[params.callId] = {
        providerRequestKey: params.providerRequestKey,
        callId: params.callId,
        provider: params.provider,
        reqKey: params.reqKey,
        purpose: params.purpose,
        status: "submitted",
        createdAt: now,
        updatedAt: now,
        requestSummary: params.requestBody ? redactRequestBody(params.requestBody) : undefined,
      };
      await writeLedger(ledger);
    },

    async recordProgress(callId, status) {
      const ledger = await readLedger();
      const entry = ledger[callId];
      if (!entry) return;
      entry.status = status;
      entry.updatedAt = new Date().toISOString();
      await writeLedger(ledger);
    },

    async recordResult(callId, result) {
      const ledger = await readLedger();
      const entry = ledger[callId];
      if (!entry) return;
      entry.status = result.status;
      entry.resultUrls = result.resultUrls;
      entry.error = result.error;
      entry.updatedAt = new Date().toISOString();
      await writeLedger(ledger);
    },

    async getEntry(callId) {
      const ledger = await readLedger();
      return ledger[callId];
    },

    async listPending() {
      const ledger = await readLedger();
      return Object.values(ledger).filter((e) => e.status === "submitted" || e.status === "polling");
    },
  };
}

/**
 * 默认 ledger。`signedRequest` 在调用方没注入时用它——保证测试脚本零配置可跑。
 * 应用装配时由组装根注入 Postgres 版覆盖（见 app/container.ts）。
 */
let activeLedger: TaskLedger = createFileTaskLedger();

/** 由组装根调用，把运行时 ledger 换成 Postgres 版 */
export function setActiveTaskLedger(ledger: TaskLedger): void {
  activeLedger = ledger;
}

export function getActiveTaskLedger(): TaskLedger {
  return activeLedger;
}

export type { TaskLedger, TaskLedgerEntry };
export type { TaskStatus } from "./taskLedgerTypes.js";
