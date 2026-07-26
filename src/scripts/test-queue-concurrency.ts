import "dotenv/config";
import { createQueues, createQueueWorker, createRedisConnection, QUEUE_NAMES, QUEUE_CONFIG } from "../lib/queues.js";

/**
 * 验证 `image-generation` 队列真的把并发压到 1。
 *
 * 这条验证不能省：并发=1 是供应商硬约束（实测超过就被 code 50430 拒），
 * 而 BullMQ 的 concurrency 配错了不会报错，只会在真实调用时随机 429。
 * 这里用一个记录「同时在跑几个」的 processor 来直接观测。
 */
const bundle = createQueues();
const connection = createRedisConnection();

let inFlight = 0;
let maxInFlight = 0;
const completionOrder: number[] = [];

const worker = createQueueWorker<{ n: number }>(
  QUEUE_NAMES.imageGeneration,
  async (job) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    // 模拟一次图片生成（真实约 13 秒，这里压缩到 300ms）
    await new Promise((r) => setTimeout(r, 300));
    completionOrder.push(job.data.n);
    inFlight -= 1;
    return { done: job.data.n };
  },
  connection,
);

try {
  const q = bundle.queues[QUEUE_NAMES.imageGeneration];
  await q.drain(true);

  const N = 6;
  console.log(`配置：concurrency=${QUEUE_CONFIG[QUEUE_NAMES.imageGeneration].concurrency}, limiter=${JSON.stringify(QUEUE_CONFIG[QUEUE_NAMES.imageGeneration].limiter)}`);
  console.log(`一次性投递 ${N} 个任务（模拟 onboarding 的 N 张预览图）...`);

  const t0 = Date.now();
  await q.addBulk(Array.from({ length: N }, (_, i) => ({ name: "render", data: { n: i + 1 } })));

  // 等全部完成
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("等待超时")), 60_000);
    const check = setInterval(async () => {
      if (completionOrder.length >= N) {
        clearInterval(check);
        clearTimeout(timer);
        resolve();
      }
    }, 100);
  });

  const elapsed = Date.now() - t0;
  console.log(`\n完成 ${completionOrder.length}/${N}，耗时 ${elapsed}ms`);
  console.log(`观测到的最大同时在跑数量：${maxInFlight}`);
  console.log(`完成顺序：${completionOrder.join(" → ")}`);

  const concurrencyOk = maxInFlight === 1;
  // limiter 每 1200ms 放 1 个，6 个任务至少需要 5×1200ms
  const throttleOk = elapsed >= 5 * 1200;
  const orderOk = completionOrder.join(",") === Array.from({ length: N }, (_, i) => i + 1).join(",");

  console.log(`\n${concurrencyOk ? "✅" : "❌"} 并发压到 1（供应商硬约束）`);
  console.log(`${throttleOk ? "✅" : "❌"} limiter 生效：6 个任务耗时 ${elapsed}ms ≥ 预期下界 6000ms`);
  console.log(`${orderOk ? "✅" : "❌"} 完成顺序 = 提交顺序（并发=1 下必然成立，所以提交顺序必须按匹配度降序）`);

  if (!concurrencyOk || !throttleOk || !orderOk) process.exit(1);
  console.log("\n全部通过。");
} finally {
  await worker.close();
  await bundle.close();
  connection.disconnect();
}
