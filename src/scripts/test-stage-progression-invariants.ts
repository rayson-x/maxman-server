import type { PrismaClient } from "../generated/prisma/client.js";
import { createStageProgressionService } from "../services/stageProgressionService.js";

/**
 * StageTask 状态机的 service seam 回归测试。
 *
 * 数据库是系统边界，因此用最小内存替身；测试只观察 public service 的返回契约：
 * done 重放无副作用、终态不能回退、最后一个 core 任务只触发一次解锁。
 */

type StoredTask = {
  id: string;
  stageId: string;
  domain: string;
  priority: "core" | "optional";
  evidenceBasis: "visual_detected";
  taskType: "simple";
  selectionStatus: "not_applicable";
  candidateOptions: null;
  styleTag: null;
  title: string;
  status: "pending" | "done" | "skipped" | "blocked" | "replaced";
  changeDescription: string;
};
type StoredStage = {
  id: string;
  planId: string;
  stageIndex: number;
  status: "locked" | "active" | "completed";
  completionPct: number;
};

const plan = {
  id: "plan-1",
  currentStage: 0,
  status: "active" as const,
};
const stages: StoredStage[] = [
  { id: "stage-0", planId: plan.id, stageIndex: 0, status: "active", completionPct: 0 },
  { id: "stage-1", planId: plan.id, stageIndex: 1, status: "locked", completionPct: 0 },
];
const tasks: StoredTask[] = [
  {
    id: "core-a",
    stageId: "stage-0",
    domain: "grooming",
    priority: "core",
    evidenceBasis: "visual_detected",
    taskType: "simple",
    selectionStatus: "not_applicable",
    candidateOptions: null,
    styleTag: null,
    title: "核心任务 A",
    status: "pending",
    changeDescription: "完成核心任务 A",
  },
  {
    id: "core-b",
    stageId: "stage-0",
    domain: "grooming",
    priority: "core",
    evidenceBasis: "visual_detected",
    taskType: "simple",
    selectionStatus: "not_applicable",
    candidateOptions: null,
    styleTag: null,
    title: "核心任务 B",
    status: "pending",
    changeDescription: "完成核心任务 B",
  },
];
const manifestByTask = new Map<string, { sourceTaskId: string }>();

const prismaBoundary: Record<string, unknown> = {
  stageTask: {
    async findFirst({ where }: { where: { id: string } }) {
      const task = tasks.find((t) => t.id === where.id);
      if (!task) return null;
      const stage = stages.find((s) => s.id === task.stageId);
      return { ...task, stage: stage ? { ...stage } : null };
    },
    async findMany({ where }: { where: { stageId: string; priority?: "core" } }) {
      return tasks
        .filter((t) => t.stageId === where.stageId && (!where.priority || t.priority === where.priority))
        .map((t) => ({ status: t.status }));
    },
    async update({ where, data }: { where: { id: string }; data: Partial<StoredTask> }) {
      const task = tasks.find((t) => t.id === where.id);
      if (!task) throw new Error("task missing");
      Object.assign(task, data);
      return { ...task };
    },
    async count({ where }: { where: { stageId: string; status?: "done" } }) {
      return tasks.filter((t) => t.stageId === where.stageId && (!where.status || t.status === where.status)).length;
    },
  },
  changeManifestEntry: {
    async findFirst({ where }: { where: { sourceTaskId: string } }) {
      return manifestByTask.get(where.sourceTaskId) ?? null;
    },
    async create({ data }: { data: { sourceTaskId: string } }) {
      if (manifestByTask.has(data.sourceTaskId)) {
        throw new Error(`duplicate manifest for ${data.sourceTaskId}`);
      }
      const entry = { sourceTaskId: data.sourceTaskId };
      manifestByTask.set(data.sourceTaskId, entry);
      return entry;
    },
    async upsert({
      where,
      create,
    }: {
      where: { sourceTaskId: string };
      create: { sourceTaskId: string };
    }) {
      const existing = manifestByTask.get(where.sourceTaskId);
      if (existing) return existing;
      const entry = { sourceTaskId: create.sourceTaskId };
      manifestByTask.set(create.sourceTaskId, entry);
      return entry;
    },
  },
  stage: {
    async findUnique({ where }: { where: { id: string } }) {
      return stages.find((s) => s.id === where.id) ?? null;
    },
    async findFirst({ where }: { where: { planId: string; stageIndex: number } }) {
      return stages.find((s) => s.planId === where.planId && s.stageIndex === where.stageIndex) ?? null;
    },
    async update({ where, data }: { where: { id: string }; data: Partial<StoredStage> }) {
      const stage = stages.find((s) => s.id === where.id);
      if (!stage) throw new Error("stage missing");
      Object.assign(stage, data);
      return { ...stage };
    },
  },
  appearancePlan: {
    async update({ data }: { data: { currentStage?: number; status?: "completed" } }) {
      Object.assign(plan, data);
      return { ...plan };
    },
  },
  async $queryRaw() {
    return [];
  },
};
prismaBoundary.$transaction = async (run: (tx: unknown) => Promise<unknown>) => run(prismaBoundary);

const progression = createStageProgressionService(prismaBoundary as unknown as PrismaClient);

const first = await progression.updateTaskStatus({
  taskId: "core-a",
  planId: plan.id,
  nextStatus: "done",
});
if (!first.ok || !first.manifestEntryCreated || first.stageUnlocked) {
  throw new Error(`首个 core 完成应写一次账本但不解锁，实际 ${JSON.stringify(first)}`);
}

const replay = await progression.updateTaskStatus({
  taskId: "core-a",
  planId: plan.id,
  nextStatus: "done",
});
if (!replay.ok || replay.manifestEntryCreated || replay.stageUnlocked) {
  throw new Error(`done 重放必须幂等且无副作用，实际 ${JSON.stringify(replay)}`);
}

const backward = await progression.updateTaskStatus({
  taskId: "core-a",
  planId: plan.id,
  nextStatus: "pending",
});
if (backward.ok || backward.code !== "invalid_transition") {
  throw new Error(`done 不得回退到 pending，实际 ${JSON.stringify(backward)}`);
}

const unlock = await progression.updateTaskStatus({
  taskId: "core-b",
  planId: plan.id,
  nextStatus: "done",
});
if (!unlock.ok || !unlock.stageUnlocked || unlock.unlockedStageIndex !== 1) {
  throw new Error(`最后一个 core 完成应恰好解锁下一阶段，实际 ${JSON.stringify(unlock)}`);
}

const unlockReplay = await progression.updateTaskStatus({
  taskId: "core-b",
  planId: plan.id,
  nextStatus: "done",
});
if (!unlockReplay.ok || unlockReplay.manifestEntryCreated || unlockReplay.stageUnlocked) {
  throw new Error(`解锁后的 done 重放不得重复账本或重复解锁，实际 ${JSON.stringify(unlockReplay)}`);
}

if (manifestByTask.size !== 2 || stages[0].status !== "completed" || stages[1].status !== "active") {
  throw new Error(
    `最终不变式错误 manifests=${manifestByTask.size} stage0=${stages[0].status} stage1=${stages[1].status}`,
  );
}

// 两个不同 core 同时完成：旧实现会让二者都拿到 stage.status=active 的快照，
// 等两次 update 都完成后又都看到 allCoreDone=true，于是返回两次 stageUnlocked。
const racePlan = { id: "race-plan", currentStage: 0, status: "active" as const };
const raceStages: StoredStage[] = [
  { id: "race-stage-0", planId: racePlan.id, stageIndex: 0, status: "active", completionPct: 0 },
  { id: "race-stage-1", planId: racePlan.id, stageIndex: 1, status: "locked", completionPct: 0 },
];
const raceTasks: StoredTask[] = ["a", "b"].map((suffix) => ({
  id: `race-core-${suffix}`,
  stageId: "race-stage-0",
  domain: "grooming",
  priority: "core",
  evidenceBasis: "visual_detected",
  taskType: "simple",
  selectionStatus: "not_applicable",
  candidateOptions: null,
  styleTag: null,
  title: `并发核心任务 ${suffix}`,
  status: "pending",
  changeDescription: `完成并发核心任务 ${suffix}`,
}));
const raceManifest = new Set<string>();
let insideTransaction = false;
let transactionTail = Promise.resolve();
let updateArrivals = 0;
let releaseBothUpdates: (() => void) | undefined;
const bothUpdatesArrived = new Promise<void>((resolve) => {
  releaseBothUpdates = resolve;
});

const raceBoundary: Record<string, unknown> = {
  stageTask: {
    async findFirst({ where }: { where: { id: string } }) {
      const task = raceTasks.find((t) => t.id === where.id);
      if (!task) return null;
      const stage = raceStages.find((s) => s.id === task.stageId);
      return { ...task, stage: stage ? { ...stage } : null };
    },
    async findMany({ where }: { where: { stageId: string; priority?: "core" } }) {
      return raceTasks
        .filter((t) => t.stageId === where.stageId && (!where.priority || t.priority === where.priority))
        .map((t) => ({ status: t.status }));
    },
    async update({ where, data }: { where: { id: string }; data: Partial<StoredTask> }) {
      const task = raceTasks.find((t) => t.id === where.id);
      if (!task) throw new Error("race task missing");
      Object.assign(task, data);
      // 未使用事务时，刻意让两个请求都完成 task.update 后再继续，稳定复现旧竞态。
      if (!insideTransaction) {
        updateArrivals += 1;
        if (updateArrivals === 2) releaseBothUpdates?.();
        await bothUpdatesArrived;
      }
      return { ...task };
    },
    async count({ where }: { where: { stageId: string; status?: "done" } }) {
      return raceTasks.filter((t) => t.stageId === where.stageId && (!where.status || t.status === where.status)).length;
    },
  },
  changeManifestEntry: {
    async findFirst({ where }: { where: { sourceTaskId: string } }) {
      return raceManifest.has(where.sourceTaskId) ? { id: `manifest-${where.sourceTaskId}` } : null;
    },
    async create({ data }: { data: { sourceTaskId: string } }) {
      raceManifest.add(data.sourceTaskId);
      return data;
    },
    async upsert({ where, create }: { where: { sourceTaskId: string }; create: { sourceTaskId: string } }) {
      raceManifest.add(where.sourceTaskId);
      return create;
    },
  },
  stage: {
    async findUnique({ where }: { where: { id: string } }) {
      return raceStages.find((s) => s.id === where.id) ?? null;
    },
    async findFirst({ where }: { where: { planId: string; stageIndex: number } }) {
      return raceStages.find((s) => s.planId === where.planId && s.stageIndex === where.stageIndex) ?? null;
    },
    async update({ where, data }: { where: { id: string }; data: Partial<StoredStage> }) {
      const stage = raceStages.find((s) => s.id === where.id);
      if (!stage) throw new Error("race stage missing");
      Object.assign(stage, data);
      return { ...stage };
    },
  },
  appearancePlan: {
    async update({ data }: { data: { currentStage?: number; status?: "completed" } }) {
      Object.assign(racePlan, data);
      return { ...racePlan };
    },
  },
  async $queryRaw() {
    return [];
  },
};
raceBoundary.$transaction = async (run: (tx: unknown) => Promise<unknown>) => {
  const previous = transactionTail;
  let releaseCurrent: (() => void) | undefined;
  transactionTail = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  await previous;
  insideTransaction = true;
  try {
    return await run(raceBoundary);
  } finally {
    insideTransaction = false;
    releaseCurrent?.();
  }
};

const raceProgression = createStageProgressionService(raceBoundary as unknown as PrismaClient);
const raceResults = await Promise.all([
  raceProgression.updateTaskStatus({
    taskId: "race-core-a",
    planId: racePlan.id,
    nextStatus: "done",
  }),
  raceProgression.updateTaskStatus({
    taskId: "race-core-b",
    planId: racePlan.id,
    nextStatus: "done",
  }),
]);
const unlockCount = raceResults.filter((r) => r.ok && r.stageUnlocked).length;
if (unlockCount !== 1) {
  throw new Error(`两个 core 并发完成必须只触发一次解锁，实际 ${unlockCount}: ${JSON.stringify(raceResults)}`);
}

console.log("✅ StageTask done 重放幂等、终态不可回退、阶段只解锁一次");
