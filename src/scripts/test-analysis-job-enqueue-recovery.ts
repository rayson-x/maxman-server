import "dotenv/config";
import type { Queue } from "bullmq";
import type { PrismaClient } from "../generated/prisma/client.js";
import { buildApp } from "../app/server.js";
import { createContainer } from "../app/container.js";
import { QUEUE_NAMES, type QueueBundle, type QueueName } from "../lib/queues.js";
import { SESSION_COOKIE_NAME } from "../services/sessionService.js";

/**
 * HTTP → BullMQ 边界回归测试。
 *
 * Redis/BullMQ 是系统边界，这里注入一个可控的 Queue.add 替身；Fastify 路由、
 * session、Prisma 与 AnalysisJob 仓储均走真实生产实现。第一次投递模拟 Redis
 * 瞬断，第二次重放同一 HTTP 请求；可观察契约是：
 *   1. 第一次明确返回可重试错误；
 *   2. 第二次重新投递原来的 created job，而不是永久“复用”一个从未入队的 job；
 *   3. 两次 BullMQ 投递使用同一个稳定 jobId，消除不确定结果下的重复任务。
 */

type AddCall = {
  name: string;
  data: unknown;
  options: { jobId?: string } | undefined;
};

const calls: AddCall[] = [];
let failNextAdd = true;

const queueBoundary = {
  async add(name: string, data: unknown, options?: { jobId?: string }) {
    calls.push({ name, data, options });
    if (failNextAdd) {
      failNextAdd = false;
      throw new Error("simulated redis outage");
    }
    return { id: options?.jobId };
  },
} as unknown as Queue;

const queues = Object.fromEntries(
  Object.values(QUEUE_NAMES).map((name) => [name, queueBoundary]),
) as Record<QueueName, Queue>;

const deviceSessionId = "enqueue-recovery-session";
const user = {
  id: "enqueue-recovery-user",
  deviceSessionId,
  phone: null,
  birthDate: null,
  ageConfirmed18Plus: true,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};
type StoredJob = {
  id: string;
  userId: string;
  planId: string | null;
  stageId: string | null;
  jobType: "initial_analysis";
  status: "created";
  errorReason: string | null;
  partialResult: unknown;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
};
let storedJob: StoredJob | null = null;
function requireStoredJob(): StoredJob {
  if (!storedJob) throw new Error("expected an AnalysisJob to exist");
  return storedJob;
}

// Prisma 也是系统边界。此测试只覆盖 route→queue 的可观察契约，因此用最小内存替身，
// 避免依赖开发机数据库迁移状态；路由与 AnalysisJob repository 仍是生产代码。
const prismaBoundary = {
  user: {
    async findUnique() {
      return user;
    },
  },
  appearanceProfile: {
    async findUnique() {
      return { budgetTier: "medium", domainSelections: ["hair"] };
    },
  },
  consentRecord: {
    async findFirst() {
      return { id: "face-consent" };
    },
  },
  userPhoto: {
    async findFirst() {
      return { id: "front-photo", moderationStatus: "passed" };
    },
  },
  analysisJob: {
    async count() {
      return 0;
    },
    async findFirst() {
      return storedJob;
    },
    async create({ data }: { data: { userId: string; jobType: "initial_analysis"; planId?: string; stageId?: string } }) {
      storedJob = {
        id: "analysis-job-stable-id",
        userId: data.userId,
        planId: data.planId ?? null,
        stageId: data.stageId ?? null,
        jobType: data.jobType,
        status: "created",
        errorReason: null,
        partialResult: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        completedAt: null,
      };
      return storedJob;
    },
    async update({ data }: { where: { id: string }; data: { errorReason?: string | null } }) {
      if (!storedJob) throw new Error("job missing");
      storedJob = { ...storedJob, ...data, updatedAt: new Date() };
      return storedJob;
    },
    async findUnique() {
      return storedJob;
    },
  },
  async $disconnect() {},
} as unknown as PrismaClient;

const container = createContainer({
  prisma: prismaBoundary,
  withQueues: false,
  withProviders: false,
});
container.queues = {
  queues,
  connection: null,
  close: async () => {},
} as unknown as QueueBundle;

const app = await buildApp({ container, logger: false });

try {
  const cookie = `${SESSION_COOKIE_NAME}=${deviceSessionId}`;

  const first = await app.inject({
    method: "POST",
    url: "/analysis-jobs",
    headers: { cookie },
  });
  if (first.statusCode !== 503) {
    throw new Error(`第一次入队失败应返回 503，实际 ${first.statusCode}: ${first.body}`);
  }

  const createdAfterFailure = requireStoredJob();
  if (createdAfterFailure.status !== "created") {
    throw new Error(`入队失败后应保留一个可恢复的 created job，实际 ${JSON.stringify(storedJob)}`);
  }

  const second = await app.inject({
    method: "POST",
    url: "/analysis-jobs",
    headers: { cookie },
  });
  if (second.statusCode !== 202) {
    throw new Error(`Redis 恢复后应重新投递并返回 202，实际 ${second.statusCode}: ${second.body}`);
  }
  const secondBody = second.json() as { jobId?: string; reused?: boolean; requeued?: boolean };
  if (
    secondBody.jobId !== createdAfterFailure.id ||
    secondBody.reused !== true ||
    secondBody.requeued !== true
  ) {
    throw new Error(`恢复投递必须复用原 DB job 并标明 requeued，实际 ${second.body}`);
  }

  if (calls.length !== 2) {
    throw new Error(`两次 HTTP 请求应跨过 Queue.add 边界两次，实际 ${calls.length}`);
  }
  const expectedBullJobId = createdAfterFailure.id;
  if (
    calls[0].options?.jobId !== expectedBullJobId ||
    calls[1].options?.jobId !== expectedBullJobId
  ) {
    throw new Error(
      `BullMQ jobId 必须稳定等于 AnalysisJob.id=${expectedBullJobId}，实际 ${JSON.stringify(calls)}`,
    );
  }

  const poll = await app.inject({
    method: "GET",
    url: `/analysis-jobs/${expectedBullJobId}`,
    headers: { cookie },
  });
  if (poll.statusCode !== 200 || poll.json().errorReason !== null) {
    throw new Error(`恢复投递后应通过公开轮询看到 enqueue 错误已清除，实际 ${poll.body}`);
  }

  console.log("✅ AnalysisJob 入队失败可由同一 HTTP 请求安全恢复，BullMQ jobId 稳定");
} finally {
  await app.close();
}
