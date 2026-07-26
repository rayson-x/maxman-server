import { Queue, Worker, type Job, type JobsOptions, type Processor } from "bullmq";
// 用具名导出 Redis 而非 default —— ioredis 是 CJS 包，NodeNext 下 default 导入
// 拿到的是 namespace（无构造签名），具名导出才是真正的类
import { Redis } from "ioredis";
import { env } from "../config/env.js";

/**
 * BullMQ 三队列（design.md 决策 1）。按任务类型隔离，各自独立并发度——
 * 避免慢任务拖垮快任务。
 *
 * 最关键的一条：`image-generation` 的 **并发必须为 1**，这不是调优选择而是
 * 供应商强制约束。实测 6 个并发提交，5 个立刻被 `code 50430 Request Has
 * Reached API Concurrent Limit` 拒绝（HTTP 429）。限制的粒度是 **req_key**
 * 而非账号（12.4 实测：文生图与图生图可并行），但同一 req_key 内就是 1。
 *
 * ⚠ **这里的配置不足以保证并发=1，别指望它**（11.2 实测）：
 *   - `concurrency: 1` 是**每 Worker 实例**上限 → 2 个实例 = 2 个在飞
 *   - `limiter {max:1, duration:1200}` 是**启动速率**限制 → 任务跑 19s，
 *     1.2s 后照样放行下一个，两个任务重叠 → 50430
 *
 * 真正的并发闸门是 `withVolcTaskSlot()`（Redis 信号量，见 lib/redisSemaphore.ts），
 * 它持槽覆盖整个 submit→poll 生命周期。本文件这两项配置降级为「减少无谓争抢」的
 * 优化：让 worker 不要一上来就堆一堆任务去抢同一个槽位。
 */

export const QUEUE_NAMES = {
  moderation: "moderation",
  textAnalysis: "text-analysis",
  imageGeneration: "image-generation",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/** 每队列的并发与限流配置 */
export const QUEUE_CONFIG: Record<QueueName, { concurrency: number; limiter?: { max: number; duration: number } }> = {
  [QUEUE_NAMES.moderation]: {
    // 内容安全调用，高并发低延迟
    concurrency: 8,
  },
  [QUEUE_NAMES.textAnalysis]: {
    // 视觉分析 + 文本推理，中等耗时；限流留余量避免撞供应商 QPS
    concurrency: 4,
    limiter: { max: 8, duration: 1000 },
  },
  [QUEUE_NAMES.imageGeneration]: {
    // ⚠ 并发=1 是供应商硬约束（实测 code 50430），不可调高
    concurrency: 1,
    // 每 1.2 秒最多 1 个任务开始，给 submit+poll 留出间隔
    limiter: { max: 1, duration: 1200 },
  },
};

/** BullMQ 要求 maxRetriesPerRequest=null，否则阻塞式命令会提前失败 */
export function createRedisConnection(): Redis {
  return new Redis(env.redis.url, { maxRetriesPerRequest: null });
}

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 2, // 与 design.md 决策 16「自动重试一次」一致
  backoff: { type: "exponential", delay: 3000 },
  removeOnComplete: { age: 7 * 24 * 3600, count: 1000 },
  removeOnFail: { age: 30 * 24 * 3600 },
};

export type QueueBundle = {
  queues: Record<QueueName, Queue>;
  connection: Redis;
  close: () => Promise<void>;
};

/**
 * 构造三个队列。刻意返回一个 bundle 由组装根持有并向下注入，
 * 不导出模块级单例——DI 要求依赖显式传递（tasks 1.6）。
 */
export function createQueues(): QueueBundle {
  const connection = createRedisConnection();
  const queues = Object.fromEntries(
    Object.values(QUEUE_NAMES).map((name) => [name, new Queue(name, { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS })]),
  ) as Record<QueueName, Queue>;

  return {
    queues,
    connection,
    close: async () => {
      await Promise.all(Object.values(queues).map((q) => q.close()));
      connection.disconnect();
    },
  };
}

/**
 * 构造 worker。并发与 limiter 一律从 QUEUE_CONFIG 取，**不接受调用方覆盖**：
 * 这两项虽然不是并发保证（见文件头，真正的闸门是 `withVolcTaskSlot`），但调高
 * `image-generation` 的并发只会让更多任务在信号量前排队空等，白占 worker 槽位。
 */
export function createQueueWorker<T = unknown, R = unknown>(
  name: QueueName,
  processor: Processor<T, R>,
  connection: Redis = createRedisConnection(),
): Worker<T, R> {
  const cfg = QUEUE_CONFIG[name];
  return new Worker<T, R>(name, processor, {
    connection,
    concurrency: cfg.concurrency,
    limiter: cfg.limiter,
  });
}

export type { Job, Queue, Worker };
