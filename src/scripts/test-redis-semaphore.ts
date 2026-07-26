import "dotenv/config";
import { Redis } from "ioredis";
import { env } from "../config/env.js";
import { withSemaphore, inspectSemaphore, closeSemaphoreRedis } from "../lib/redisSemaphore.js";

/**
 * 信号量的边界行为测试（不花钱、秒级）。
 *
 * 与 `test-queue-real-supplier.ts` 分工：那个证明**结果**对（真实供应商不再 429），
 * 这个证明**边界**对（TTL 过期自动释放、超时后不误删别人的槽、多槽位并行）。
 * 后者用真实调用验证太贵也太慢，用 sleep 替身正合适——这里被替换掉的是「耗时工作」，
 * 而不是「被测机制」本身，所以替身不会掩盖问题。
 */

const redis = new Redis(env.redis.url, { maxRetriesPerRequest: null });
let pass = 0, fail = 0;
const check = (ok: boolean, label: string, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? `  ${detail}` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function clear(name: string, slots = 4) {
  for (let i = 0; i < slots; i++) await redis.del(`sem:${name}:${i}`);
}

try {
  // ── 1. 单槽位互斥：这是 11.2 的核心保证 ──
  await clear("t-mutex");
  {
    let concurrent = 0, maxConcurrent = 0;
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3, 4].map((n) =>
        withSemaphore("t-mutex", { slots: 1, ttlMs: 5000, pollIntervalMs: 50 }, async () => {
          concurrent += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          order.push(n);
          await sleep(120);
          concurrent -= 1;
        }),
      ),
    );
    check(maxConcurrent === 1, "slots=1 时最大并发为 1", `观测 ${maxConcurrent}`);
    check(order.length === 4, "4 个任务全部执行（阻塞但不丢弃）", `${order.length}/4`);
  }

  // ── 2. 多槽位：并发数等于槽位数，不多不少 ──
  await clear("t-multi");
  {
    let concurrent = 0, maxConcurrent = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        withSemaphore("t-multi", { slots: 2, ttlMs: 5000, pollIntervalMs: 50 }, async () => {
          concurrent += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await sleep(100);
          concurrent -= 1;
        }),
      ),
    );
    check(maxConcurrent === 2, "slots=2 时最大并发为 2（扩容路径可用）", `观测 ${maxConcurrent}`);
  }

  // ── 3. 正常路径释放槽位 ──
  await clear("t-release");
  await withSemaphore("t-release", { slots: 1, ttlMs: 5000 }, async () => sleep(10));
  check((await inspectSemaphore("t-release", 1)).occupied === 0, "正常完成后槽位被释放");

  // ── 4. 抛异常也要释放，否则一次失败就永久占死一个槽 ──
  await clear("t-throw");
  await withSemaphore("t-throw", { slots: 1, ttlMs: 5000 }, async () => {
    throw new Error("boom");
  }).catch(() => {});
  check((await inspectSemaphore("t-throw", 1)).occupied === 0, "**fn 抛异常后槽位仍被释放**（否则一次失败永久占死）");

  // ── 5. TTL 过期自动释放：持有者进程崩溃时的兜底 ──
  await clear("t-ttl");
  await redis.set("sem:t-ttl:0", "dead-holder", "PX", 300);
  check((await inspectSemaphore("t-ttl", 1)).occupied === 1, "模拟崩溃持有者：槽位被占");
  const ttlStart = Date.now();
  await withSemaphore("t-ttl", { slots: 1, ttlMs: 5000, pollIntervalMs: 50 }, async () => sleep(5));
  const waited = Date.now() - ttlStart;
  check(waited >= 250 && waited < 3000, "崩溃持有者的槽位在 TTL 后被自动接管（不死锁）", `等待 ${waited}ms`);

  // ── 6. 释放时校验 token：执行超过 TTL 时不能误删别人的槽 ──
  // 这是最隐蔽的一条：若无 token 校验，超时者结束时会删掉接班人的槽，
  // 并发保护当场失效——正是 11.2 要防的情形。
  await clear("t-token");
  {
    const slow = withSemaphore("t-token", { slots: 1, ttlMs: 200, pollIntervalMs: 30 }, async () => {
      await sleep(900); // 刻意远超 TTL 200ms
    });
    await sleep(400); // 此时 TTL 已过期，槽位空出
    await redis.set("sem:t-token:0", "next-holder", "PX", 5000); // 接班人抢到
    await slow; // 超时者结束 → 若无 token 校验会误删接班人的槽
    const current = await redis.get("sem:t-token:0");
    check(current === "next-holder", "**超时持有者不会误删接班人的槽位**（token 校验生效）", `槽位持有者=${current}`);
  }

  // ── 7. 抢不到槽位时超时报错，而不是无限等待 ──
  await clear("t-timeout");
  await redis.set("sem:t-timeout:0", "squatter", "PX", 10_000);
  let timedOut = false;
  await withSemaphore("t-timeout", { slots: 1, ttlMs: 5000, pollIntervalMs: 50, acquireTimeoutMs: 400 }, async () => {})
    .catch((e) => { timedOut = /超时/.test(e.message); });
  check(timedOut, "抢不到槽位时按 acquireTimeoutMs 超时报错（不无限挂起）");

  console.log(`\n${fail === 0 ? "全部通过" : "有失败项"}：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exitCode = 1;
} finally {
  for (const n of ["t-mutex", "t-multi", "t-release", "t-throw", "t-ttl", "t-token", "t-timeout"]) await clear(n);
  redis.disconnect();
  await closeSemaphoreRedis();
}
