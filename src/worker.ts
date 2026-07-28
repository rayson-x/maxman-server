import "dotenv/config";
import { createContainer } from "./app/container.js";
import { createQueueWorker, createRedisConnection, QUEUE_NAMES, QUEUE_CONFIG, type Job } from "./lib/queues.js";
import { createJobOrchestrator, type JobPayload } from "./app/jobOrchestrator.js";
import { createWorkerJobProcessor } from "./app/workerProcessor.js";
import { createDataDeletionService } from "./services/dataDeletionService.js";
import { createDualSourceReviewer } from "./features/dual-source-recommendation/reviewer.js";

/**
 * Worker 进程入口（tasks 1.7）。与 API 进程分离，独立扩容。
 *
 * 并发保护不依赖副本数：`withVolcTaskSlot` 的 Redis 信号量跨进程保证在飞 ≤1
 * （见 lib/redisSemaphore.ts，11.2 实测）。多副本跑 image-generation 是安全的，
 * 只是多余副本大多时间在等槽位。moderation / text-analysis 可放心多副本。
 *
 * 用 WORKER_QUEUES 环境变量选择本进程消费哪些队列，默认全部：
 *   WORKER_QUEUES=image-generation   → 只跑图片生成（建议单副本部署）
 *   WORKER_QUEUES=moderation,text-analysis → 跑其余两个（可多副本）
 */
const container = createContainer();
const connection = createRedisConnection();

const requested = (process.env.WORKER_QUEUES ?? Object.values(QUEUE_NAMES).join(","))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const validNames = new Set<string>(Object.values(QUEUE_NAMES));
for (const name of requested) {
  if (!validNames.has(name)) {
    console.error(`未知队列名 "${name}"。可选：${[...validNames].join(", ")}`);
    process.exit(2);
  }
}

/**
 * processor = 编排器的薄适配层。
 *
 * 这里刻意只做「解析 payload → 交给编排器」，不放任何业务逻辑：
 * 编排逻辑要能被脚本直接调用来测（不必起 Redis 和队列），放进 processor 就锁死在
 * 队列里了。此前这三个 processor 是占位实现，收到任务只打日志——路由、step、
 * 状态机全都实现了，唯独没人把它们接起来，于是 HTTP 全链路一直是断的。
 */
const orchestrator = createJobOrchestrator(container);
const deletion = createDataDeletionService(container.prisma);
const dualSourceReviewer = createDualSourceReviewer(container.prisma);

/** job.name 即 jobType（路由投递时以 jobType 命名，见 routes/analysisJobs.ts） */
async function dispatch(job: Job): Promise<unknown> {
  if (job.name === "dual_source_reviewer") {
    const comparisonId = (job.data as { comparisonId?: unknown } | null)?.comparisonId;
    if (typeof comparisonId !== "string" || comparisonId.length === 0) {
      throw new Error("invalid dual_source_reviewer payload");
    }
    return dualSourceReviewer.review(comparisonId);
  }
  const payload = job.data as JobPayload;
  const jobType = job.name as Parameters<typeof orchestrator.run>[0];
  if (!payload?.jobId) {
    // 没有 jobId 就无处记录失败，只能在这里拒掉。data_deletion 之类的运维任务
    // 不走编排器，直接跳过而不是误判为失败。
    console.warn(`[worker] job ${job.id} (${job.name}) 无 jobId，跳过`);
    return { skipped: true, reason: "no_jobId" };
  }
  const result = await orchestrator.run(jobType, payload);
  console.log(`[worker] ${jobType} job ${payload.jobId} → ${result.status}`);
  return result;
}

const processJob = createWorkerJobProcessor({
  runOrchestratedJob: dispatch,
  executeDeletion: deletion.executeDeletion,
});

const processors: Record<string, (job: Job) => Promise<unknown>> = {
  [QUEUE_NAMES.moderation]: processJob,
  [QUEUE_NAMES.textAnalysis]: processJob,
  [QUEUE_NAMES.imageGeneration]: processJob,
};

const workers = requested.map((name) => {
  const cfg = QUEUE_CONFIG[name as keyof typeof QUEUE_CONFIG];
  console.log(`启动 worker: ${name}  concurrency=${cfg.concurrency}${cfg.limiter ? ` limiter=${JSON.stringify(cfg.limiter)}` : ""}`);
  const w = createQueueWorker(name as keyof typeof QUEUE_CONFIG, processors[name], connection);
  w.on("failed", (job, err) => console.error(`[${name}] job ${job?.id} 失败:`, err.message));
  return w;
});

const shutdown = async (signal: string) => {
  console.log(`收到 ${signal}，等待在途任务结束后关闭`);
  await Promise.all(workers.map((w) => w.close()));
  connection.disconnect();
  await container.shutdown();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

console.log(`worker 就绪，消费队列: ${requested.join(", ")}`);
