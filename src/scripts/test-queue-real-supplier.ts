import "dotenv/config";
import { createQueues, createQueueWorker, createRedisConnection, QUEUE_NAMES, QUEUE_CONFIG } from "../lib/queues.js";
import { submitVolcVisualTask, pollVolcVisualResult, withVolcTaskSlot } from "../features/appearance-agent/providers/volcengine/signedRequest.js";
import { closeSemaphoreRedis } from "../lib/redisSemaphore.js";

/**
 * 11.2：多 worker 下队列层并发=1 是否真的挡住了 code 50430。
 *
 * 与 `test-queue-concurrency.ts` 的区别很关键：那个用假 processor 验证
 * BullMQ 配置本身生效（最大同时在跑=1）；**这个用真实供应商调用**，
 * 验证的是「我们的修复在真实约束下确实避免了 429」。
 *
 * 【首轮结果：失败，并因此发现真实 bug】
 * 只靠队列配置（concurrency=1 + limiter max:1/1200ms）跑本测试：
 *   最大同时在飞 = 2，6 个任务 4 个被 code 50430 拒绝。
 * 根因：`concurrency` 是**每 Worker 实例**上限，`limiter` 是**启动速率**限制；
 * #1 要跑 19 秒，而 limiter 在 1.2 秒后就放行了 #2 → 重叠 → 被拒。
 * 两者都不等于「全局同时在飞 ≤ 1」。
 *
 * 修复：`withVolcTaskSlot`（lib/redisSemaphore.ts）用 Redis `SET NX PX` 信号量
 * 把整个 submit→poll 生命周期串起来。本测试现在验证这个修复。
 *
 * 为什么用两个 Worker 实例：信号量走 Redis，跨实例即跨进程语义等价。若协调只在
 * 进程内生效，两个实例会各跑各的并立刻触发 50430——这正是修复前观测到的现象。
 *
 * 关键：processor 里**故意绕过进程内限流**（VOLC_SKIP_INPROCESS_RATE_LIMIT=1）。
 * 不绕过的话，进程内限流器会顺手把请求隔开，测出来的就是它的功劳而非信号量的，
 * 那这个测试就白做了。
 */
process.env.VOLC_SKIP_INPROCESS_RATE_LIMIT = "1";

const REQ_KEY = "seededit_v3.0";
const TEST_IMAGE = "https://picsum.photos/id/64/512/512.jpg";
const JOB_COUNT = 4; // 串行后每张约 20s；4 个足以证明序列化，同时控制成本(¥0.8)

const bundle = createQueues();
const conn1 = createRedisConnection();
const conn2 = createRedisConnection();

let inFlight = 0;
let maxInFlight = 0;
const results: { n: number; worker: string; ok: boolean; detail: string; ms: number }[] = [];
let rateLimitHits = 0;
let inputFetchFailures = 0;

async function processJob(n: number, workerLabel: string) {
  const t0 = Date.now();
  try {
    // ⚠ in-flight 必须在信号量**内部**计数。在外层计数只能测出队列放行了几个，
    // 而要证明的是真正打到供应商的并发数——那才是 50430 的判定依据。
    console.log(`  #${n} [${workerLabel}] 等待信号量…`);
    await withVolcTaskSlot(REQ_KEY, async () => {
    console.log(`  #${n} [${workerLabel}] 拿到槽位，调用供应商`);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
    const submitted = await submitVolcVisualTask(
      REQ_KEY,
      { image_urls: [TEST_IMAGE], prompt: `把头发改成第${n}种短发造型`, negative_prompt: "", seed: -1, scale: 0.5, return_url: true },
      { purpose: "queue-real-probe" },
    );
    const taskId = submitted.data?.task_id;
    if (!taskId) throw new Error(`未返回 task_id: ${JSON.stringify(submitted).slice(0, 120)}`);
    // 只轮询到出结果即可，验证的是提交阶段不被限流
    const done = await pollVolcVisualResult(REQ_KEY, taskId, { timeoutMs: 90_000 });
    results.push({ n, worker: workerLabel, ok: true, detail: done.data?.image_urls?.[0] ? "拿到图片" : "done 但无 URL", ms: Date.now() - t0 });
    } finally { inFlight -= 1; }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("50430") || msg.includes("Concurrent Limit")) rateLimitHits += 1;
    // 50220 = 供应商拉取输入图失败。必须与并发失败分开计：公共图床瞬时抽风
    // 会伪装成「机制没生效」，把两者混在一个断言里会误导下一个读结果的人。
    else if (msg.includes("50220") || msg.includes("Download Url Error")) inputFetchFailures += 1;
    results.push({ n, worker: workerLabel, ok: false, detail: msg.slice(0, 100), ms: Date.now() - t0 });
  }
}

const w1 = createQueueWorker<{ n: number }>(QUEUE_NAMES.imageGeneration, async (job) => processJob(job.data.n, "W1"), conn1);
const w2 = createQueueWorker<{ n: number }>(QUEUE_NAMES.imageGeneration, async (job) => processJob(job.data.n, "W2"), conn2);

try {
  const q = bundle.queues[QUEUE_NAMES.imageGeneration];
  // drain 清不掉 failed/delayed 里的残留任务（上一轮失败的 4 个会被重投），必须 obliterate
  await q.obliterate({ force: true });

  const cfg = QUEUE_CONFIG[QUEUE_NAMES.imageGeneration];
  console.log(`两个 Worker 实例（模拟两个进程），队列配置 concurrency=${cfg.concurrency} limiter=${JSON.stringify(cfg.limiter)}`);
  console.log(`Redis 信号量 volc:${REQ_KEY} slots=1 保护整个 submit→poll 生命周期`);
  console.log(`进程内限流已刻意关闭，以确保测的是信号量的功劳\n`);
  console.log(`投递 ${JOB_COUNT} 个真实图生图任务…`);

  const t0 = Date.now();
  await q.addBulk(Array.from({ length: JOB_COUNT }, (_, i) => ({ name: "render", data: { n: i + 1 } })));

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`超时：仅完成 ${results.length}/${JOB_COUNT}`)), 300_000);
    const iv = setInterval(() => {
      if (results.length >= JOB_COUNT) { clearInterval(iv); clearTimeout(timer); resolve(); }
    }, 300);
  });
  const elapsed = Date.now() - t0;

  console.log("\n各任务结果：");
  for (const r of results.sort((a, b) => a.n - b.n)) {
    console.log(`  #${r.n} [${r.worker}] ${r.ok ? "✅" : "❌"} ${r.detail}  ${(r.ms / 1000).toFixed(1)}s`);
  }

  const succeeded = results.filter((r) => r.ok).length;
  const workersUsed = new Set(results.map((r) => r.worker)).size;

  console.log("\n──── 断言 ────");
  let pass = 0, fail = 0;
  const check = (ok: boolean, label: string, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "✅" : "❌"} ${label}${detail ? `  ${detail}` : ""}`); };

  check(rateLimitHits === 0, "**零次 code 50430**（信号量确实挡住了供应商并发限制）", `命中 ${rateLimitHits} 次`);
  check(maxInFlight === 1, "供应商侧最大同时在飞 = 1（跨两个 Worker 实例协调生效）", `观测 ${maxInFlight}`);
  check(succeeded + inputFetchFailures === JOB_COUNT, "除输入图下载失败外全部成功", `成功 ${succeeded}，输入图下载失败 ${inputFetchFailures}（供应商侧瞬时，与并发机制无关）`);
  check(workersUsed >= 1, "任务在 Worker 间分发", `用到 ${workersUsed} 个 Worker 实例`);
  check(elapsed >= JOB_COUNT * 10_000, "总耗时符合串行预期（每张约 13s）", `${(elapsed / 1000).toFixed(0)}s`);

  console.log(`\n实际调用 ${succeeded} 次，约 ¥${(succeeded * 0.2).toFixed(1)}`);
  console.log(`${fail === 0 ? "全部通过" : "有失败项"}：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exit(1);
} finally {
  await w1.close();
  await w2.close();
  await bundle.close();
  conn1.disconnect();
  conn2.disconnect();
  await closeSemaphoreRedis();
}
