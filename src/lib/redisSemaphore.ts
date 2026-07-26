import { Redis } from "ioredis";
import { env } from "../config/env.js";

/**
 * Redis 分布式信号量。
 *
 * 存在的理由是一个实测出来的 bug：BullMQ 的 `concurrency` 是**每个 Worker 实例**
 * 的上限，`limiter` 是**启动速率**限制——两者都给不了「全局同时在飞不超过 N 个」。
 *
 * 实测现场（2 个 Worker 实例 + 真实图生图调用）：
 *   #1 开始 → 耗时 19.4s
 *   1.2s 后 limiter 放行 #2 → 与 #1 重叠 → 供应商返回 code 50430
 *   6 个任务里 4 个被拒
 *
 * 而早前用假 processor（300ms）的测试却"通过"了——因为 300ms < 1200ms 限流间隔，
 * 任务从不重叠，bug 被完全掩盖。这是「快速替身掩盖真实时序问题」的典型例子。
 *
 * 为什么不靠「只部署一个 worker」：那是脆弱约定。一次部署失误（副本数配成 2、
 * 蓝绿发布期间新旧并存）就会静默产生 429，而失败的是用户正在等的效果图。
 * 约束应该由代码保证，不是由运维记性保证。
 *
 * 实现要点：
 *   - `SET key value NX PX ttl` 原子抢占，天然跨进程
 *   - **TTL 必须大于最长调用耗时**，否则持有者还在跑就被别人抢走，又回到并发冲突
 *   - 持有者崩溃时靠 TTL 自动释放，不会死锁（与 agent-lock 的租约同思路）
 *   - 释放时校验 token，避免误删别人的锁（自己超时后别人已抢到的情况）
 */

export type SemaphoreOptions = {
  /** 并发槽位数。Volcengine 各 req_key 独立池，实测每池上限为 1 */
  slots: number;
  /** 槽位租约时长，必须大于最长单次调用耗时 */
  ttlMs: number;
  /** 抢不到时的重试间隔 */
  pollIntervalMs?: number;
  /** 抢占总超时 */
  acquireTimeoutMs?: number;
};

const DEFAULTS = {
  pollIntervalMs: 400,
  acquireTimeoutMs: 180_000,
};

let sharedRedis: Redis | undefined;

function getRedis(): Redis {
  if (!sharedRedis) {
    sharedRedis = new Redis(env.redis.url, { maxRetriesPerRequest: null });
  }
  return sharedRedis;
}

/** 仅供测试重置连接 */
export async function closeSemaphoreRedis(): Promise<void> {
  if (sharedRedis) {
    sharedRedis.disconnect();
    sharedRedis = undefined;
  }
}

function slotKey(name: string, index: number): string {
  return `sem:${name}:${index}`;
}

/**
 * 在信号量保护下执行 fn。**整个 submit→poll 生命周期都必须在锁内**——
 * 只锁 submit 是不够的：供应商的并发计数看的是「服务端有几个任务在跑」，
 * 而不是「有几个 HTTP 请求在途」。
 */
export async function withSemaphore<T>(name: string, opts: SemaphoreOptions, fn: () => Promise<T>): Promise<T> {
  const redis = getRedis();
  const pollInterval = opts.pollIntervalMs ?? DEFAULTS.pollIntervalMs;
  const timeout = opts.acquireTimeoutMs ?? DEFAULTS.acquireTimeoutMs;
  const token = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const deadline = Date.now() + timeout;

  let heldKey: string | undefined;
  while (Date.now() < deadline) {
    for (let i = 0; i < opts.slots; i++) {
      const key = slotKey(name, i);
      const ok = await redis.set(key, token, "PX", opts.ttlMs, "NX");
      if (ok === "OK") {
        heldKey = key;
        break;
      }
    }
    if (heldKey) break;
    await new Promise((r) => setTimeout(r, pollInterval));
  }

  if (!heldKey) {
    throw new Error(`获取信号量 ${name} 超时（${timeout}ms）——所有 ${opts.slots} 个槽位持续被占用`);
  }

  try {
    return await fn();
  } finally {
    // 只删自己持有的槽位：若本次执行超过 TTL，槽位可能已被别人抢到，
    // 此时误删会让并发保护失效
    const current = await redis.get(heldKey);
    if (current === token) {
      await redis.del(heldKey);
    }
  }
}

/** 观测用：查看某信号量当前占用情况 */
export async function inspectSemaphore(name: string, slots: number): Promise<{ occupied: number; slots: number }> {
  const redis = getRedis();
  let occupied = 0;
  for (let i = 0; i < slots; i++) {
    if (await redis.exists(slotKey(name, i))) occupied += 1;
  }
  return { occupied, slots };
}
