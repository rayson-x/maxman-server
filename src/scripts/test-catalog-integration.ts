import "dotenv/config";
import { createContainer } from "../app/container.js";
import { materializePlanStep, type MaterializeTaskSpec } from "../steps/materializePlan.js";

/**
 * 验证 CandidateTaskCatalog 真的能被 S5 消费，且阶段落位符合时间尺度。
 * 这一步是 10.6 的实际意义所在——入库了但落位不对等于没做。
 */
const container = createContainer({ withProviders: false, withQueues: false });
const prisma = container.prisma;
let pass = 0, fail = 0;
const check = (ok: boolean, label: string, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "✅" : "❌"} ${label}${detail ? `  ${detail}` : ""}`); };

try {
  const recommended = await prisma.candidateTaskCatalog.findMany({ where: { isRecommended: true } });
  const excluded = await prisma.candidateTaskCatalog.findMany({ where: { isRecommended: false } });
  check(recommended.length >= 20, "可推荐条目足够覆盖非风格领域", `${recommended.length} 条`);
  check(excluded.length === 3 && excluded.every(e => Boolean(e.exclusionReason)), "排除条目均写明原因", `${excluded.length} 条`);
  check(excluded.every(e => e.applicableStageRange.length === 0), "排除条目无阶段范围（永不落位）");

  console.log("\n=== 阶段落位符合时间尺度（决策 7）===");
  const byStage: Record<string, string[]> = { stage0: [], stage1: [], stage2: [], stage3: [] };
  for (const e of recommended) for (const st of e.applicableStageRange) byStage[st]?.push(e.methodName);
  for (const [st, names] of Object.entries(byStage)) console.log(`  ${st}: ${names.length} 条 — ${names.slice(0, 3).join("、")}${names.length > 3 ? "…" : ""}`);

  const s0 = byStage.stage0;
  check(s0.some(n => n.includes("胡须")) && s0.some(n => n.includes("指甲")), "阶段0 是当天可做的仪容清理");
  check(!s0.some(n => n.includes("力量训练") || n.includes("矫正")), "阶段0 不含需要数周/数年的项");
  check(byStage.stage3.some(n => n.includes("力量训练")), "力量训练落阶段3");
  check(byStage.stage3.some(n => n.includes("矫正")), "牙齿矫正落阶段3（周期最长）");

  console.log("\n=== 从目录生成方案（真实消费）===");
  const user = await prisma.user.create({ data: { deviceSessionId: `cat-${Date.now()}` } });
  const plan = await prisma.appearancePlan.create({
    data: { userId: user.id, track: "long_term", generationSeed: 1,
      stages: { create: [0,1,2,3].map(i => ({ stageIndex: i, windowLabel: "", status: "locked", unlockRule: {} })) } },
    include: { stages: true },
  });
  const job = await prisma.analysisJob.create({ data: { userId: user.id, planId: plan.id, jobType: "plan_materialization" } });

  // 把目录条目转成 S5 的输入（真实流程里由 TextPlanningProvider 打分，这里给固定分验落位）
  const specs: MaterializeTaskSpec[] = recommended.map((e, i) => ({
    domain: e.domain,
    title: e.methodName,
    applicableStageRange: e.applicableStageRange,
    evidenceBasis: e.evidenceBasis,
    changeDescription: e.description.slice(0, 40),
    estTime: e.estTime ?? undefined,
    estCost: e.estCostRange ?? undefined,
    dimensions: { visualBenefit: e.visualBenefitLevel === "high" ? 9 : e.visualBenefitLevel === "medium" ? 6 : 3,
      credibility: 8, acceptance: 7, reversibility: e.reversibility === "full" ? 9 : 4,
      timeCost: 3, moneyCost: 3, risk: e.riskLevel === "high" ? 8 : e.riskLevel === "medium" ? 5 : 1 },
  }));

  const r = await materializePlanStep.run({ planId: plan.id, tasks: specs }, { jobId: job.id, userId: user.id, planId: plan.id }, { prisma, providers: container.providers });
  check(r.status === "completed", "S5 成功从目录落地方案", r.status);
  const out = r.status === "completed" ? r.data : null;
  console.log("  落位结果：");
  for (const s of out!.stages) console.log(`    阶段${s.stageIndex}: ${s.taskCount} 任务（${s.coreCount} core）`);

  check(out!.stages.every(s => s.coreCount <= 3), "每阶段 core 不超上限（否则永远解锁不了）");
  check(out!.stages[0].taskCount > 0 && out!.stages[3].taskCount > 0, "阶段0 与阶段3 都有任务");

  const gbpTasks = await prisma.stageTask.findMany({ where: { stage: { planId: plan.id }, evidenceBasis: "general_best_practice" } });
  check(gbpTasks.length > 0 && gbpTasks.every(t => t.priority === "optional"),
    "所有 general_best_practice 任务均为 optional（打分前硬门槛）", `${gbpTasks.length} 条全部 optional`);

  const excludedInPlan = await prisma.stageTask.findMany({ where: { stage: { planId: plan.id }, title: { in: excluded.map(e => e.methodName) } } });
  check(excludedInPlan.length === 0, "被排除的方法**不会**出现在任何用户方案里", `Mewing/下颌线训练器/面部瑜伽 均未出现`);

  await prisma.user.delete({ where: { id: user.id } });
  console.log(`\n${fail === 0 ? "全部通过" : "有失败项"}：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exit(1);
} finally { await prisma.$disconnect(); }
