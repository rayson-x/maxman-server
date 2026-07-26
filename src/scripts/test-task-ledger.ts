import "dotenv/config";
import { createPrismaClient } from "../lib/prisma.js";
import { createPrismaTaskLedger } from "../lib/prismaTaskLedger.js";
import { createFileTaskLedger, setActiveTaskLedger, getActiveTaskLedger } from "../lib/taskLedger.js";
import type { TaskLedger } from "../lib/taskLedgerTypes.js";

/**
 * 验证两个 ledger 实现**行为一致**（同一套断言跑两遍），以及注入机制生效。
 *
 * 行为一致很重要：测试脚本用文件版、生产用 Postgres 版，如果两者语义有差异，
 * 测试通过不代表生产可用。
 */
const prisma = createPrismaClient();
let pass = 0, fail = 0;
const check = (ok: boolean, label: string, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "✅" : "❌"} ${label}${detail ? `  ${detail}` : ""}`);
};

async function runSuite(name: string, ledger: TaskLedger) {
  console.log(`\n=== ${name} ===`);
  const callId = `test-${name}-${Date.now()}`;

  await ledger.recordSubmitted({
    callId,
    provider: "volcengine",
    reqKey: "seededit_v3.0",
    purpose: "image-edit",
    // 长 base64 应被脱敏，不落盘
    requestBody: { prompt: "把头发改成寸头", binary_data_base64: ["A".repeat(2000)], scale: 0.5 },
  });

  const afterSubmit = await ledger.getEntry(callId);
  check(afterSubmit?.status === "submitted", "提交后立刻可查（崩溃也不丢账）", afterSubmit?.status);
  check(afterSubmit?.reqKey === "seededit_v3.0", "reqKey 落盘（恢复轮询要靠它）");
  const summary = afterSubmit?.requestSummary as Record<string, unknown> | undefined;
  check(
    typeof summary?.binary_data_base64 === "object" &&
      JSON.stringify(summary?.binary_data_base64).includes("omitted, length=2000"),
    "长 base64 被脱敏（不把图片塞进账本）",
  );
  check(summary?.prompt === "把头发改成寸头", "短字段原样保留");

  await ledger.recordProgress(callId, "polling");
  check((await ledger.getEntry(callId))?.status === "polling", "轮询中状态更新");

  const pending = await ledger.listPending();
  check(pending.some((e) => e.callId === callId), "在途任务可枚举（供恢复扫描）", `pending=${pending.length}`);

  await ledger.recordResult(callId, { status: "done", resultUrls: ["https://example.invalid/a.png"] });
  const done = await ledger.getEntry(callId);
  check(done?.status === "done" && done?.resultUrls?.[0] === "https://example.invalid/a.png", "完成态与结果 URL 落盘");
  check(!(await ledger.listPending()).some((e) => e.callId === callId), "完成后不再出现在在途列表");

  // 重复提交同一 callId 不该炸（重试后可能拿到同一个 task_id）
  let threw = false;
  try {
    await ledger.recordSubmitted({ callId, provider: "volcengine", reqKey: "seededit_v3.0" });
  } catch {
    threw = true;
  }
  check(!threw, "重复提交同一 callId 不抛异常（记账目的是不丢，不是唯一性检查）");

  // 未知 callId 的更新应静默忽略而非抛错
  let threw2 = false;
  try {
    await ledger.recordProgress("nonexistent-call-id", "polling");
  } catch {
    threw2 = true;
  }
  check(!threw2, "更新不存在的 callId 静默忽略");

  return callId;
}

try {
  const fileCallId = await runSuite("文件版", createFileTaskLedger());
  const pgLedger = createPrismaTaskLedger(prisma);
  const pgCallId = await runSuite("Postgres 版", pgLedger);

  console.log("\n=== 注入机制 ===");
  const before = getActiveTaskLedger();
  setActiveTaskLedger(pgLedger);
  check(getActiveTaskLedger() === pgLedger, "setActiveTaskLedger 生效（组装根可切换后端）");
  check(before !== pgLedger, "默认是文件版（测试脚本零配置可跑）");

  // 跨进程可见性的实质验证：新建一个 ledger 实例（模拟另一个进程）能查到同一条记录
  const anotherProcessLedger = createPrismaTaskLedger(prisma);
  const seen = await anotherProcessLedger.getEntry(pgCallId);
  check(Boolean(seen), "另一个 ledger 实例能查到同一条记录（跨进程恢复的前提）", seen?.status);

  await prisma.providerCallLog.deleteMany({ where: { callId: { startsWith: "test-" } } });
  console.log(`\n${fail === 0 ? "全部通过" : "有失败项"}：${pass} 通过 / ${fail} 失败（两套实现各跑一遍同样断言）`);
  if (fail > 0) process.exit(1);
} finally {
  await prisma.$disconnect();
}
