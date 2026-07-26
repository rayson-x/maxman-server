import "dotenv/config";
import { createContainer } from "../app/container.js";
import { createPlanRevisionService } from "../services/planRevisionService.js";
import { createTargetImageService, checkGeneratedImageQuality, IDENTITY_PRESERVATION_SUFFIX } from "../services/targetImageService.js";
import type { StyleVector } from "../features/appearance-agent/data/styleProfile.js";

/**
 * 第 9 节 + 8.7/8.8 验证。重点断言：
 *   - 换风格保留已完成账本（事实不可撤销）
 *   - 空集时给**时间预期**而非一句"不行"
 *   - 风格衍生任务拒绝单独替换，路由到换风格
 *   - 账本校准：回退条目时对应任务也退回 pending（不能两边矛盾）
 *   - 目标图失败不阻塞阶段推进，且不消耗额度
 */
const container = createContainer({ withProviders: false, withQueues: false });
const prisma = container.prisma;
const revision = createPlanRevisionService(prisma);
let pass = 0, fail = 0;
const check = (ok: boolean, label: string, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "✅" : "❌"} ${label}${detail ? `  ${detail}` : ""}`); };
const v = (f: number, m: number, b: number, u: number): StyleVector => ({ formality: f, maturity: m, boldness: b, upkeep: u });

try {
  console.log("=== 8.7 身份保留约束写进指令 ===");
  check(IDENTITY_PRESERVATION_SUFFIX.includes("脸型") && IDENTITY_PRESERVATION_SUFFIX.includes("骨骼")
     && IDENTITY_PRESERVATION_SUFFIX.includes("性别") && IDENTITY_PRESERVATION_SUFFIX.includes("肌肉"),
    "保留约束覆盖脸型/骨骼/性别/身材（写进提示词而非事后检查）");

  console.log("\n=== 8.7 质量检查拦结构性问题 ===");
  const tiny = await checkGeneratedImageQuality(Buffer.alloc(500));
  check(!tiny.passed, "过小的响应被拦（可能是错误页）", tiny.issues[0]?.slice(0, 40));
  const notImage = await checkGeneratedImageQuality(Buffer.from("<html>error</html>".repeat(2000)));
  check(!notImage.passed && notImage.issues.some(i => i.includes("PNG/JPEG")), "非图片内容被拦（HTTP 200 也可能是错误页）");
  const validPng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(50000)]);
  check((await checkGeneratedImageQuality(validPng)).passed, "有效 PNG 通过");

  console.log("\n=== 9.2 空集 → 时间预期（不是一句「不行」）===");
  const shortHair = revision.assessStyleChange({
    candidates: [
      { entryId: "long", nameZh: "中长发文艺风", styleVector: v(4, 5, 5, 5), requiredHairLengthCm: 15 },
      { entryId: "medium", nameZh: "中等长度碎盖", styleVector: v(3, 4, 4, 4), requiredHairLengthCm: 8 },
    ],
    completedVectors: [v(2, 4, 2, 1)], // 已剪寸头
    currentHairLengthCm: 2,
  });
  check(shortHair.available.length === 0, "已剪寸头 → 需长发的方向全部不可用");
  check(Boolean(shortHair.emptySetMessage?.includes("周后")), "给出等待周数而非拒绝", shortHair.emptySetMessage?.slice(0, 60));
  const soonest = shortHair.blocked.filter(b => b.availableInWeeks).sort((a,b) => a.availableInWeeks! - b.availableInWeeks!)[0];
  check(soonest.candidate.nameZh === "中等长度碎盖", "优先推荐最快可用的方向", `${soonest.candidate.nameZh} 约 ${soonest.availableInWeeks} 周`);

  console.log("\n=== 9.1 向量兼容性约束 ===");
  const assess = revision.assessStyleChange({
    candidates: [
      { entryId: "close", nameZh: "相近风格", styleVector: v(3, 4, 3, 2) },
      { entryId: "far", nameZh: "差异过大的风格", styleVector: v(9, 8, 5, 7) },
    ],
    completedVectors: [v(2, 4, 2, 1)],
  });
  check(assess.available.length === 1 && assess.available[0].entryId === "close", "相近风格可换");
  check(assess.blocked.some(b => b.candidate.entryId === "far" && b.reason.includes("差")), "差异过大被挡并说明哪个维度差多少", assess.blocked[0]?.reason.slice(0, 50));

  console.log("\n=== 9.1 执行换风格 ===");
  const user = await prisma.user.create({ data: { deviceSessionId: `rev-${Date.now()}` } });
  const plan = await prisma.appearancePlan.create({
    data: { userId: user.id, track: "short_term", generationSeed: 1, selectedHairstyleId: "old-hair",
      stages: { create: [0,1,2,3].map(i => ({ stageIndex: i, windowLabel: `S${i}`, status: "locked", unlockRule: {} })) } },
    include: { stages: true },
  });
  const st = plan.stages.find(s => s.stageIndex === 1)!;
  const hairTask = await prisma.stageTask.create({ data: { stageId: st.id, domain: "hair", priority: "core", evidenceBasis: "visual_detected", title: "剪发", changeDescription: "发型改变" } });
  const skinTask = await prisma.stageTask.create({ data: { stageId: st.id, domain: "skincare", priority: "optional", evidenceBasis: "general_best_practice", title: "日常护肤", changeDescription: "皮肤状态改善" } });
  const doneEntry = await prisma.changeManifestEntry.create({ data: { planId: plan.id, stageId: st.id, domain: "grooming", changeDescription: "胡须剃干净", verificationStatus: "unverified" } });

  const applied = await revision.applyStyleChange({ planId: plan.id, newHairstyleId: "new-hair" });
  check(applied.ok === true, "换风格执行成功");
  if (applied.ok) {
    check(applied.retainedEntries === 1, "已完成账本全部保留（事实不可撤销）", `保留 ${applied.retainedEntries} 条`);
    check(applied.planVersion === 2, "plan_version 递增而非重置（同一方案的演进）", `v${applied.planVersion}`);
    check(applied.replacedTasks === 1, "只替换风格衍生任务", `替换 ${applied.replacedTasks} 个（hair）`);
  }
  const skinAfter = await prisma.stageTask.findUnique({ where: { id: skinTask.id } });
  check(skinAfter?.status === "pending", "非风格任务不受换风格波及", `护肤任务仍为 ${skinAfter?.status}`);

  console.log("\n=== 9.3 风格任务拒绝单独替换 ===");
  const hair2 = await prisma.stageTask.create({ data: { stageId: st.id, domain: "hair", priority: "core", evidenceBasis: "visual_detected", title: "剪发2", changeDescription: "发型改变2" } });
  const rejected = await revision.replaceNonStyleTask({ taskId: hair2.id, planId: plan.id });
  check(!rejected.ok && rejected.code === "must_change_style", "发型任务拒绝单独替换，路由到换风格", !rejected.ok ? rejected.reason.slice(0, 50) : "");

  console.log("\n=== 9.4 非风格任务同领域替换 ===");
  await prisma.candidateTaskCatalog.create({ data: { domain: "skincare", methodName: "基础保湿流程", description: "早晚保湿", evidenceBasis: "visual_detected", reversibility: "full", riskLevel: "low", applicableStageRange: ["stage1"] } });
  const replaced = await revision.replaceNonStyleTask({ taskId: skinTask.id, planId: plan.id });
  check(replaced.ok === true, "非风格任务可替换为同领域等价条目");
  if (replaced.ok) {
    const old = await prisma.stageTask.findUnique({ where: { id: replaced.replacedTaskId } });
    const neo = await prisma.stageTask.findUnique({ where: { id: replaced.newTaskId } });
    check(old?.status === "replaced" && neo?.title === "基础保湿流程", "旧任务标 replaced，新任务从目录取", `${old?.status} → ${neo?.title}`);
  }

  console.log("\n=== 决策 13：账本校准 ===");
  const reconciled = await revision.reconcileManifest({ planId: plan.id, unverifiedDescriptions: ["胡须剃干净"] });
  check(reconciled.rolledBack === 1, "照片显示未完成的条目被回退", `回退 ${reconciled.rolledBack} 条`);
  const entryAfter = await prisma.changeManifestEntry.findUnique({ where: { id: doneEntry.id } });
  check(entryAfter?.verificationStatus === "rolled_back" && Boolean(entryAfter?.verifiedAt), "条目标记 rolled_back 并记录校准时间");
  check(reconciled.planVersion === 3, "校准也递增 plan_version", `v${reconciled.planVersion}`);

  // 关键：回退条目对应的任务必须也退回 pending，否则任务说完成、账本说没做，两边矛盾
  const entryWithTask = await prisma.changeManifestEntry.create({ data: { planId: plan.id, stageId: st.id, sourceTaskId: hair2.id, domain: "hair", changeDescription: "剪成寸头", verificationStatus: "unverified" } });
  await prisma.stageTask.update({ where: { id: hair2.id }, data: { status: "done" } });
  await revision.reconcileManifest({ planId: plan.id, unverifiedDescriptions: ["剪成寸头"] });
  const taskAfter = await prisma.stageTask.findUnique({ where: { id: hair2.id } });
  check(taskAfter?.status === "pending", "回退账本条目时对应任务也退回 pending（避免两边矛盾）", `任务 done → ${taskAfter?.status}`);

  console.log("\n=== 8.8 目标图失败不阻塞 ===");
  const svc = createTargetImageService(prisma, container.providers);
  const photo = await prisma.userPhoto.create({ data: { userId: user.id, photoType: "front", storageKey: `raw/${user.id}/f.jpg`, moderationStatus: "passed" } });
  const job = await prisma.analysisJob.create({ data: { userId: user.id, planId: plan.id, jobType: "stage_unlock_generation" } });
  const genResult = await svc.generateForStage({ jobId: job.id, planId: plan.id, stageId: st.id, imageType: "face_hair" });
  check(genResult.ok === false && genResult.stageStillUnlocked === true,
    "生成失败明确返回 stageStillUnlocked:true（目标图是激励物不是门槛）");
  const failedImg = await prisma.targetImage.findFirst({ where: { planId: plan.id, qualityCheckStatus: "failed" } });
  check(failedImg?.consumedWeeklyQuota === false, "失败**不消耗额度**（决策 15）");
  const runs = await prisma.workflowRun.findMany({ where: { jobId: job.id } });
  check(runs.length > 0 && runs[0].finalStatus === "failed" && runs[0].cost != null,
    "tasks 7.9：WorkflowRun 记录成本/延迟/重试供核算", `cost=¥${runs[0].cost} retry=${runs[0].retryCount}`);

  await prisma.candidateTaskCatalog.deleteMany({ where: { methodName: "基础保湿流程" } });
  await prisma.user.delete({ where: { id: user.id } });
  console.log(`\n${fail === 0 ? "全部通过" : "有失败项"}：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exit(1);
} finally { await prisma.$disconnect(); }
