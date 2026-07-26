import "dotenv/config";
import { rm } from "node:fs/promises";
import { createPrismaClient } from "../lib/prisma.js";
import { createFileTaskLedger } from "../lib/taskLedger.js";
import { createPrismaTaskLedger } from "../lib/prismaTaskLedger.js";
import type { TaskLedger } from "../lib/taskLedgerTypes.js";

/**
 * 付费调用账本的生命周期。**两套实现跑同一批断言**——
 * 行为一致才谈得上「测试用文件版、生产用 Postgres 版」。
 *
 * 被测的核心是崩溃窗口的处置：
 *   写 prepared → HTTP 已被供应商接受 → 记录结果之前崩溃
 * 恢复时库里是 prepared，而供应商可能已经计费。火山不接受客户端幂等键、
 * 也没有按客户端键查询的接口，所以只能承认不可知：转 unknown，不自动重提。
 */

const prisma = createPrismaClient();
let pass = 0, fail = 0;
const check = (ok: boolean, label: string, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? `  ${detail}` : ""}`);
};

async function runSuite(name: string, ledger: TaskLedger, tag: string) {
  console.log(`\n── ${name} ──`);
  const rk = `${tag}-req-${Date.now()}`;
  const callId = `${tag}-task-${Date.now()}`;

  // ① prepared 在提交之前存在
  await ledger.recordPrepared({ providerRequestKey: rk, provider: "volcengine", reqKey: "seededit_v3.0", purpose: "test" });
  const prepared = await ledger.getEntry(rk);
  check(prepared?.status === "prepared", "提交前存在 prepared 记录", `status=${prepared?.status}`);
  check(prepared?.callId === undefined, "prepared 阶段没有 callId（供应商 task_id 还不知道）");

  // ② prepared 不进 pending：它可能从未真正发出，恢复流程不该去轮询
  const pendingWhilePrepared = await ledger.listPending();
  check(
    !pendingWhilePrepared.some((e) => e.providerRequestKey === rk),
    "**prepared 不算 pending**（可能从未发出，不该被轮询）",
  );

  // ③ 提交成功后关联到同一条账，而不是另起一行
  await ledger.recordSubmitted({ providerRequestKey: rk, callId, provider: "volcengine", reqKey: "seededit_v3.0", purpose: "test" });
  const submitted = await ledger.getEntry(callId);
  check(submitted?.status === "submitted" && submitted.callId === callId, "提交后状态转 submitted 且带 callId");
  const orphan = await ledger.getEntry(rk);
  check(
    orphan === undefined || orphan.callId === callId,
    "**一次调用只留一条账**（prepared 被关联而非留下孤儿）",
    orphan ? `残留 status=${orphan.status}` : "无残留",
  );

  // ④ 过期的 prepared 转 unknown，不自动重提
  const staleRk = `${tag}-stale-${Date.now()}`;
  await ledger.recordPrepared({ providerRequestKey: staleRk, provider: "volcengine", reqKey: "seededit_v3.0" });
  const swept = await ledger.sweepStale(-1); // 负数=立刻视为过期
  check(swept >= 1, "sweepStale 处理了过期记录", `count=${swept}`);
  const stale = await ledger.getEntry(staleRk);
  check(stale?.status === "unknown", "**过期 prepared 转 unknown**（终态，不自动重提）", `status=${stale?.status}`);
  check(Boolean(stale?.error), "unknown 带上需人工对账的说明", stale?.error?.slice(0, 30));

  // ⑤ unknown 不被恢复流程当成待重试
  const pendingAfter = await ledger.listPending();
  check(
    !pendingAfter.some((e) => e.providerRequestKey === staleRk),
    "**unknown 不出现在待处理列表**（否则恢复流程会重复提交重复付费）",
  );

  // ⑥ 正常完成路径不受影响
  await ledger.recordResult(callId, { status: "done", resultUrls: ["https://example.com/x.png"] });
  const done = await ledger.getEntry(callId);
  check(done?.status === "done" && done.resultUrls?.length === 1, "正常完成路径仍工作");
}

try {
  await rm("data/task-ledger.json", { force: true });
  await runSuite("文件版账本", createFileTaskLedger(), "file");
  await runSuite("Postgres 版账本", createPrismaTaskLedger(prisma), "pg");

  console.log(`\n${fail === 0 ? "全部通过" : "有失败项"}：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exitCode = 1;
} finally {
  await prisma.providerCallLog.deleteMany({ where: { provider: "volcengine", reqKey: "seededit_v3.0", purpose: "test" } });
  await prisma.providerCallLog.deleteMany({ where: { providerRequestKey: { startsWith: "pg-stale-" } } });
  await rm("data/task-ledger.json", { force: true });
  await prisma.$disconnect();
}
