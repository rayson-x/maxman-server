import "dotenv/config";
import { createContainer } from "../app/container.js";
import { materializePlanStep, computeCompositeScore, type MaterializeTaskSpec } from "../steps/materializePlan.js";
import { renderOutfitPreviewsStep } from "../steps/renderPreviews.js";
import type { StepContext, StepDeps } from "../steps/types.js";

/**
 * S5 落位与 S4' 降级路径验证。重点断言的是两条最容易被写错的设计：
 *   - 阶段落位读 applicableStageRange，**与打分无关**（高分长周期任务不能进阶段0）
 *   - general_best_practice 无论分多高都只能是 optional（打分前的硬门槛）
 *   - 阶段0 不生成目标图
 *   - 无全身照 → 不造全身照，降级为文字+示意图并明确告知
 */
const container = createContainer({ withProviders: false, withQueues: false });
const prisma = container.prisma;
let pass = 0, fail = 0;
const check = (ok: boolean, label: string, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "✅" : "❌"} ${label}${detail ? `  ${detail}` : ""}`); };

const dims = (vb: number, cost: number) => ({
  visualBenefit: vb, credibility: 8, acceptance: 8, reversibility: 8,
  timeCost: cost, moneyCost: cost, risk: 1,
});

try {
  const user = await prisma.user.create({ data: { deviceSessionId: `s5-${Date.now()}` } });
  const plan = await prisma.appearancePlan.create({
    data: {
      userId: user.id, track: "short_term", generationSeed: 12345,
      stages: { create: [0, 1, 2, 3].map((i) => ({ stageIndex: i, windowLabel: "", status: "locked", unlockRule: {} })) },
    },
  });
  const job = await prisma.analysisJob.create({ data: { userId: user.id, planId: plan.id, jobType: "plan_materialization" } });
  const ctx: StepContext = { jobId: job.id, userId: user.id, planId: plan.id };
  const deps: StepDeps = { prisma, providers: container.providers };

  const tasks: MaterializeTaskSpec[] = [
    // 高分但长周期 —— 决不能被放进阶段0
    { domain: "fitness", title: "系统减脂训练", applicableStageRange: ["stage3"], evidenceBasis: "self_reported",
      changeDescription: "体型变得更精练", dimensions: dims(10, 1), estTime: "6-12周" },
    // 低分但当天可做
    { domain: "grooming", title: "剃干净胡须", applicableStageRange: ["stage0"], evidenceBasis: "visual_detected",
      changeDescription: "胡须剃干净", dimensions: dims(3, 1), estTime: "10分钟" },
    { domain: "grooming", title: "把衬衫下摆塞好", applicableStageRange: ["stage0"], evidenceBasis: "visual_detected",
      changeDescription: "衬衫下摆整理好", dimensions: dims(2, 1), estTime: "1分钟" },
    // general_best_practice 且分极高 —— 必须仍是 optional
    { domain: "body_odor", title: "使用止汗露", applicableStageRange: ["stage0"], evidenceBasis: "general_best_practice",
      changeDescription: "体味管理", dimensions: dims(10, 1), estTime: "1分钟" },
    // guided_selection：候选各带 changeDescription
    { domain: "hair", title: "换一个适合脸型的发型", applicableStageRange: ["stage1"], evidenceBasis: "visual_detected",
      changeDescription: "发型改变", dimensions: dims(9, 3), estTime: "1小时",
      candidateOptions: [
        { styleTag: "微碎盖", changeDescription: "剪成微碎盖，前额留碎发" },
        { styleTag: "寸头", changeDescription: "剪成清爽寸头" },
      ] },
    { domain: "outfit", title: "现有衣物改合身", applicableStageRange: ["stage1", "stage2"], evidenceBasis: "visual_detected",
      changeDescription: "上衣改合身", dimensions: dims(8, 2) },
  ];

  const r = await materializePlanStep.run({ planId: plan.id, tasks }, ctx, deps);
  check(r.status === "completed", "S5 完成", r.status);
  const out = r.status === "completed" ? r.data : null;

  console.log("\n阶段落位结果：");
  for (const s of out!.stages) {
    console.log(`  阶段${s.stageIndex}(${s.windowLabel})：${s.taskCount} 任务，${s.coreCount} core，目标图=${s.hasTargetImage ? "有" : "无"}`);
  }

  const stage0 = out!.stages[0], stage3 = out!.stages[3];
  check(stage0.taskCount === 3, "阶段0 收到 3 个当天可做的任务", `${stage0.taskCount}`);
  check(stage3.taskCount === 1, "高分长周期任务落到阶段3（打分不影响落位）", `减脂训练 visualBenefit=10 仍在阶段3`);
  check(stage0.hasTargetImage === false, "阶段0 不生成目标图（决策 4）");
  check(out!.stages.slice(1).every((s) => s.hasTargetImage), "阶段1-3 才有目标图");

  const stage0Tasks = await prisma.stageTask.findMany({
    where: { stage: { planId: plan.id, stageIndex: 0 } }, orderBy: { sortOrder: "asc" },
  });
  const deodorant = stage0Tasks.find((t) => t.title === "使用止汗露");
  check(deodorant?.priority === "optional",
    "general_best_practice 分最高(10) 仍被强制为 optional（打分前的硬门槛）",
    `visualBenefit=10 → priority=${deodorant?.priority}`);
  check(deodorant?.sortOrder === 0, "但它排序仍在最前（分高）——门槛只管 core 资格，不管排序", `sortOrder=${deodorant?.sortOrder}`);

  const guided = await prisma.stageTask.findFirst({ where: { stage: { planId: plan.id, stageIndex: 1 }, taskType: "guided_selection" } });
  const opts = guided?.candidateOptions as { styleTag: string; changeDescription: string }[] | null;
  check(guided?.selectionStatus === "pending_selection", "guided_selection 任务初始为 pending_selection");
  check(opts?.length === 2 && opts.every((o) => Boolean(o.changeDescription)),
    "每个候选带自己的 changeDescription（决策 11，选中后可直接落为计划变化）");

  console.log("\n=== 加权公式 ===");
  const high = computeCompositeScore(dims(10, 1));
  const low = computeCompositeScore(dims(2, 8));
  check(high > low, "收益项加、成本项减", `高收益低成本=${high} > 低收益高成本=${low}`);

  console.log("\n=== S4' 无全身照降级 ===");
  const degraded = await renderOutfitPreviewsStep.run({
    candidates: [{
      candidateId: "outfit-reference",
      nameZh: "素色 T 恤 + 直筒裤",
      modelRationale: "颜色克制、版型利落",
      renderInstruction: "换成素色 T 恤和直筒裤",
    }],
  }, ctx, deps);
  const dd = degraded.status === "completed" ? degraded.data : null;
  check(degraded.status === "completed" && dd?.mode === "text_and_reference_only",
    "无全身照 → 不造全身照，降级为文字+示意图（决策 11）", dd?.mode);
  check(
    dd!.previews.length === 1 &&
      dd!.previews[0].referenceOnly === true &&
      dd!.previews[0].storageKey === null,
    "降级模式保留可选择的文字候选，但不产生任何本人效果图（不消耗生成配额）",
  );
  check(Boolean(dd?.supplementaryPrompt?.includes("全身照")), "以中性方式给出补拍引导，而不是静默少给内容");
  console.log(`     提示文案：${dd?.supplementaryPrompt}`);

  await prisma.user.delete({ where: { id: user.id } });
  console.log(`\n${fail === 0 ? "全部通过" : "有失败项"}：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exit(1);
} finally {
  await prisma.$disconnect();
}
