import "dotenv/config";
import { createPrismaClient } from "../lib/prisma.js";
import { createContainer } from "../app/container.js";
import { materializePlanStep, type MaterializeTaskSpec } from "../steps/materializePlan.js";
import type { StepContext } from "../steps/types.js";

/**
 * S5 幂等性。
 *
 * 为什么单独测：S5 被 `runWithSingleRetry` 包着，所以**非幂等 = 一次中途失败后的
 * 重试就把任务插两遍**。实测过原始行为——重跑后阶段 0 从 4 个任务变 8 个，
 * 同一方法同时以 core 和 optional 各出现一次。用户看到的是一份自相矛盾的清单。
 *
 * 同时验证反向要求：**已完成/已跳过的任务不能被重跑抹掉**。
 * 全删重建实现起来更简单，但那会清掉用户进度，还会断开
 * `ChangeManifestEntry.sourceTaskId` 的追溯链。
 */

const prisma = createPrismaClient();
const container = createContainer({ withProviders: false });
let pass = 0, fail = 0;
const check = (ok: boolean, label: string, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? `  ${detail}` : ""}`);
};

const SPECS: MaterializeTaskSpec[] = [
  { domain: "face_grooming", title: "修整眉形", applicableStageRange: ["stage0"], evidenceBasis: "visual_detected", changeDescription: "眉形修整过", estTime: "10 分钟", dimensions: { visualBenefit: 6, credibility: 9, acceptance: 8, reversibility: 9, timeCost: 1, moneyCost: 1, risk: 1 } },
  { domain: "face_grooming", title: "剃净胡须", applicableStageRange: ["stage0"], evidenceBasis: "visual_detected", changeDescription: "胡须已剃净", estTime: "10 分钟", dimensions: { visualBenefit: 6, credibility: 9, acceptance: 8, reversibility: 9, timeCost: 1, moneyCost: 1, risk: 1 } },
  { domain: "face_grooming", title: "鼻毛清理", applicableStageRange: ["stage0"], evidenceBasis: "general_best_practice", changeDescription: "鼻毛已清理", estTime: "5 分钟", dimensions: { visualBenefit: 3, credibility: 3, acceptance: 5, reversibility: 9, timeCost: 1, moneyCost: 1, risk: 1 } },
  { domain: "skincare", title: "基础清洁保湿", applicableStageRange: ["stage1"], evidenceBasis: "visual_detected", changeDescription: "已建立护肤流程", estTime: "1-7 天", dimensions: { visualBenefit: 6, credibility: 9, acceptance: 7, reversibility: 9, timeCost: 5, moneyCost: 3, risk: 1 } },
];

const prefix = `idem-${Date.now()}`;
try {
  const user = await prisma.user.create({ data: { deviceSessionId: `${prefix}-dev`, ageConfirmed18Plus: true } });
  const plan = await prisma.appearancePlan.create({
    data: {
      userId: user.id, track: "short_term", generationSeed: 42,
      stages: { create: [0, 1, 2, 3].map((i) => ({ stageIndex: i, windowLabel: "", status: i === 0 ? "active" : "locked", unlockRule: {} })) },
    },
    include: { stages: { orderBy: { stageIndex: "asc" } } },
  });
  const ctx: StepContext = { jobId: "n/a", userId: user.id, planId: plan.id };
  const deps = { prisma, providers: container.providers };

  const countTasks = () => prisma.stageTask.count({ where: { stageId: { in: plan.stages.map((s) => s.id) } } });
  const countCore = (stageId: string) => prisma.stageTask.count({ where: { stageId, priority: "core" } });

  // 第一次落地
  const r1 = await materializePlanStep.run({ planId: plan.id, tasks: SPECS, maxCorePerStage: 2 }, ctx, deps);
  check(r1.status === "completed", "首次落地成功");
  const n1 = await countTasks();
  check(n1 === SPECS.length, `首次产出 ${SPECS.length} 个任务`, `实际 ${n1}`);
  const core1 = await countCore(plan.stages[0].id);
  check(core1 === 2, "阶段0 core 数受 maxCorePerStage=2 约束", `实际 ${core1}`);

  // 第二次落地：**总数必须不变**
  const r2 = await materializePlanStep.run({ planId: plan.id, tasks: SPECS, maxCorePerStage: 2 }, ctx, deps);
  check(r2.status === "completed", "重跑成功");
  const n2 = await countTasks();
  check(n2 === n1, "**重跑后任务总数不变**（幂等，不重复插入）", `首次 ${n1} → 重跑 ${n2}`);

  const dupes = await prisma.$queryRaw<{ title: string; n: bigint }[]>`
    SELECT t.title, COUNT(*) as n FROM "StageTask" t
    JOIN "Stage" s ON s.id = t."stageId"
    WHERE s."planId" = ${plan.id} GROUP BY t.title HAVING COUNT(*) > 1`;
  check(dupes.length === 0, "无重复标题的任务", dupes.length > 0 ? JSON.stringify(dupes.map((d) => `${d.title}×${Number(d.n)}`)) : "");

  // 用户完成一项后重跑：进度必须保留
  const doneTask = await prisma.stageTask.findFirst({ where: { stageId: plan.stages[0].id, priority: "core" } });
  await prisma.stageTask.update({ where: { id: doneTask!.id }, data: { status: "done" } });
  await prisma.changeManifestEntry.create({
    data: { planId: plan.id, stageId: plan.stages[0].id, sourceTaskId: doneTask!.id, domain: doneTask!.domain, changeDescription: doneTask!.changeDescription ?? "x" },
  });

  const r3 = await materializePlanStep.run({ planId: plan.id, tasks: SPECS, maxCorePerStage: 2 }, ctx, deps);
  check(r3.status === "completed", "有已完成任务时重跑成功");
  const stillDone = await prisma.stageTask.findUnique({ where: { id: doneTask!.id } });
  check(stillDone?.status === "done", "**已完成的任务在重跑后仍存在且仍为 done**（进度不被抹掉）", `实际 ${stillDone?.status ?? "已被删除"}`);

  const manifestStillLinked = await prisma.changeManifestEntry.findFirst({ where: { planId: plan.id, sourceTaskId: doneTask!.id } });
  check(Boolean(manifestStillLinked), "账本条目与来源任务的追溯链未断");

  const n3 = await countTasks();
  check(n3 === n1, "第三次重跑总数依旧不变", `${n3} vs ${n1}`);
  const core3 = await countCore(plan.stages[0].id);
  check(core3 === 2, "保留的 core 计入名额，未超出 maxCorePerStage", `实际 ${core3}`);

  console.log(`\n${fail === 0 ? "全部通过" : "有失败项"}：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exitCode = 1;
} finally {
  await prisma.user.deleteMany({ where: { deviceSessionId: { startsWith: prefix } } });
  await container.shutdown();
  await prisma.$disconnect();
}
