import assert from "node:assert/strict";
import test from "node:test";
import type { Queue } from "bullmq";
import type { PrismaClient } from "../generated/prisma/client.js";
import { buildApp } from "../app/server.js";
import { createContainer } from "../app/container.js";
import { QUEUE_NAMES, type QueueBundle, type QueueName } from "../lib/queues.js";
import { SESSION_COOKIE_NAME } from "../services/sessionService.js";

/**
 * Public HTTP → BullMQ seam.
 *
 * The database and BullMQ are system boundaries, so this test supplies small
 * in-memory substitutes while exercising the real Fastify route and real stage
 * progression service. A task-status replay must recover a failed stage-unlock
 * enqueue without creating a second AnalysisJob or a second BullMQ job.
 */
test("stage unlock enqueue failure is recoverable through task-status replay", async () => {
  const userId = "stage-unlock-user";
  const deviceSessionId = "stage-unlock-session";
  const plan = {
    id: "stage-unlock-plan",
    userId,
    currentStage: 0,
    status: "active" as const,
  };
  const stages = [
    {
      id: "stage-0",
      planId: plan.id,
      stageIndex: 0,
      status: "active" as "active" | "completed" | "locked",
      completionPct: 0,
    },
    {
      id: "stage-1",
      planId: plan.id,
      stageIndex: 1,
      status: "locked" as "active" | "completed" | "locked",
      completionPct: 0,
    },
  ];
  const task = {
    id: "final-core-task",
    stageId: stages[0].id,
    domain: "grooming",
    priority: "core" as const,
    evidenceBasis: "visual_detected" as const,
    taskType: "simple" as const,
    selectionStatus: "not_applicable" as const,
    candidateOptions: null,
    styleTag: null,
    title: "完成最后一个核心任务",
    status: "pending" as "pending" | "done" | "skipped" | "blocked" | "replaced",
    changeDescription: "完成最后一个核心任务",
  };
  const manifestByTask = new Map<string, { id: string; sourceTaskId: string }>();
  const analysisJobs: Array<{
    id: string;
    userId: string;
    planId: string;
    stageId: string;
    jobType: "stage_unlock_generation";
    status: "created";
    errorReason: string | null;
    createdAt: Date;
  }> = [];

  const prismaBoundary: Record<string, unknown> = {
    user: {
      async findUnique() {
        return {
          id: userId,
          deviceSessionId,
          phone: null,
          birthDate: null,
          ageConfirmed18Plus: true,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        };
      },
    },
    appearancePlan: {
      async findFirst({ where }: { where: { id?: string; userId?: string } }) {
        return where.id === plan.id && where.userId === userId ? { ...plan } : null;
      },
      async update({ data }: { data: { currentStage?: number; status?: "completed" } }) {
        Object.assign(plan, data);
        return { ...plan };
      },
    },
    stageTask: {
      async findFirst({ where }: { where: { id: string } }) {
        if (where.id !== task.id) return null;
        const stage = stages.find((candidate) => candidate.id === task.stageId);
        return { ...task, stage: stage ? { ...stage } : null };
      },
      async findMany({ where }: { where: { stageId: string; priority?: "core" } }) {
        return task.stageId === where.stageId && (!where.priority || where.priority === task.priority)
          ? [{ status: task.status }]
          : [];
      },
      async update({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<typeof task>;
      }) {
        if (where.id !== task.id) throw new Error("task missing");
        Object.assign(task, data);
        return { ...task };
      },
      async count({ where }: { where: { stageId: string; status?: "done" } }) {
        if (where.stageId !== task.stageId) return 0;
        return !where.status || task.status === where.status ? 1 : 0;
      },
    },
    changeManifestEntry: {
      async findFirst({ where }: { where: { sourceTaskId: string } }) {
        return manifestByTask.get(where.sourceTaskId) ?? null;
      },
      async create({ data }: { data: { sourceTaskId: string } }) {
        const entry = { id: `manifest-${data.sourceTaskId}`, sourceTaskId: data.sourceTaskId };
        manifestByTask.set(data.sourceTaskId, entry);
        return entry;
      },
    },
    stage: {
      async findFirst({ where }: { where: { planId: string; stageIndex: number } }) {
        return stages.find(
          (candidate) =>
            candidate.planId === where.planId && candidate.stageIndex === where.stageIndex,
        ) ?? null;
      },
      async update({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<(typeof stages)[number]>;
      }) {
        const stage = stages.find((candidate) => candidate.id === where.id);
        if (!stage) throw new Error("stage missing");
        Object.assign(stage, data);
        return { ...stage };
      },
    },
    analysisJob: {
      async findFirst({
        where,
      }: {
        where: {
          userId: string;
          planId: string;
          stageId?: string;
          jobType: "stage_unlock_generation";
          status?: "created";
          errorReason?: { startsWith: string };
        };
      }) {
        return analysisJobs.find((job) =>
          job.userId === where.userId &&
          job.planId === where.planId &&
          (!where.stageId || job.stageId === where.stageId) &&
          job.jobType === where.jobType &&
          (!where.status || job.status === where.status) &&
          (!where.errorReason || job.errorReason?.startsWith(where.errorReason.startsWith)),
        ) ?? null;
      },
      async create({
        data,
      }: {
        data: {
          userId: string;
          planId: string;
          stageId: string;
          jobType: "stage_unlock_generation";
        };
      }) {
        const job = {
          id: "stable-stage-unlock-job",
          ...data,
          status: "created" as const,
          errorReason: null,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        };
        analysisJobs.push(job);
        return job;
      },
      async update({
        where,
        data,
      }: {
        where: { id: string };
        data: { errorReason: string | null };
      }) {
        const job = analysisJobs.find((candidate) => candidate.id === where.id);
        if (!job) throw new Error("analysis job missing");
        Object.assign(job, data);
        return { ...job };
      },
    },
    async $queryRaw() {
      return [];
    },
    async $disconnect() {},
  };
  prismaBoundary.$transaction = async (run: (tx: unknown) => Promise<unknown>) =>
    run(prismaBoundary);

  const addCalls: Array<{
    name: string;
    data: unknown;
    options: { jobId?: string } | undefined;
  }> = [];
  let failNextAdd = true;
  const queueBoundary = {
    async add(name: string, data: unknown, options?: { jobId?: string }) {
      addCalls.push({ name, data, options });
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

  const container = createContainer({
    prisma: prismaBoundary as unknown as PrismaClient,
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
    const request = () =>
      app.inject({
        method: "POST",
        url: `/plans/${plan.id}/tasks/${task.id}/status`,
        headers: { cookie: `${SESSION_COOKIE_NAME}=${deviceSessionId}` },
        payload: { status: "done" },
      });

    const first = await request();
    assert.equal(first.statusCode, 503, first.body);
    assert.equal(first.json().retryable, true);
    assert.equal(task.status, "done");
    assert.equal(stages[0].status, "completed");
    assert.equal(stages[1].status, "active");
    assert.equal(analysisJobs.length, 1);
    assert.match(analysisJobs[0].errorReason ?? "", /^queue_enqueue_failed:/);

    const second = await request();
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(second.json().generationRequeued, true);
    assert.equal(analysisJobs.length, 1);
    assert.equal(analysisJobs[0].errorReason, null);
    assert.equal(addCalls.length, 2);
    assert.equal(addCalls[0].options?.jobId, analysisJobs[0].id);
    assert.equal(addCalls[1].options?.jobId, analysisJobs[0].id);

    const third = await request();
    assert.equal(third.statusCode, 200, third.body);
    assert.equal(analysisJobs.length, 1);
    assert.equal(addCalls.length, 2, "successful recovery must not enqueue again on later replay");
  } finally {
    await app.close();
  }
});
