import "dotenv/config";
import { createContainer } from "../app/container.js";
import { buildApp } from "../app/server.js";
import { SESSION_COOKIE_NAME } from "../services/sessionService.js";
import { createStageProgressionService } from "../services/stageProgressionService.js";

/**
 * 第 8 节验证。重点断言最容易实现错的几条：
 *   - 核心任务不可跳过（决策 14）
 *   - guided_selection 未选定不能标完成
 *   - 选定只改 selectionStatus，不动 status，不写账本
 *   - 完成才写账本，且用**选中候选**的 changeDescription
 *   - 解锁实时判定（optional 未完成不影响解锁）
 *   - 目标图输入 = 基准 + 已完成账本 + 本阶段 core 计划变化（决策 4 的核心）
 */
const container = createContainer();
const app = await buildApp({ container, logger: false });
const prisma = container.prisma;
const progression = createStageProgressionService(prisma);
let pass = 0, fail = 0;
const check = (ok: boolean, label: string, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "✅" : "❌"} ${label}${detail ? `  ${detail}` : ""}`); };

try {
  const s = await app.inject({ method: "POST", url: "/auth/device-session" });
  const sid = s.json().deviceSessionId as string;
  const cookie = `${SESSION_COOKIE_NAME}=${sid}`;
  const user = (await prisma.user.findUnique({ where: { deviceSessionId: sid } }))!;
  const photo = await prisma.userPhoto.create({ data: { userId: user.id, photoType: "front", storageKey: `raw/${user.id}/base.jpg`, moderationStatus: "passed" } });

  const plan = await prisma.appearancePlan.create({
    data: { userId: user.id, track: "short_term", generationSeed: 777,
      stages: { create: [0,1,2,3].map(i => ({ stageIndex: i, windowLabel: `阶段${i}`, status: i===0?"active":"locked", unlockRule: {} })) } },
    include: { stages: { orderBy: { stageIndex: "asc" } } },
  });
  const st0 = plan.stages[0], st1 = plan.stages[1];

  const coreA = await prisma.stageTask.create({ data: { stageId: st0.id, domain: "grooming", priority: "core",
    evidenceBasis: "visual_detected", title: "剃干净胡须", changeDescription: "胡须剃干净", sortOrder: 0 } });
  const coreB = await prisma.stageTask.create({ data: { stageId: st0.id, domain: "grooming", priority: "core",
    evidenceBasis: "visual_detected", title: "整理眉毛", changeDescription: "眉形整理干净", sortOrder: 1 } });
  const opt = await prisma.stageTask.create({ data: { stageId: st0.id, domain: "other", priority: "optional",
    evidenceBasis: "general_best_practice", title: "使用止汗露", changeDescription: "体味管理", sortOrder: 2 } });
  const guided = await prisma.stageTask.create({ data: { stageId: st1.id, domain: "hair", priority: "core",
    evidenceBasis: "visual_detected", taskType: "guided_selection", selectionStatus: "pending_selection",
    title: "换发型", changeDescription: "发型改变（占位）", sortOrder: 0,
    candidateOptions: [{ styleTag: "微碎盖", changeDescription: "剪成微碎盖，前额留碎发" }, { styleTag: "寸头", changeDescription: "剪成清爽寸头" }] } });

  const post = (taskId: string, status: string) => app.inject({ method: "POST", url: `/plans/${plan.id}/tasks/${taskId}/status`, headers: { cookie }, payload: { status } });

  console.log("=== 8.2 核心任务不可跳过 ===");
  const skipCore = await post(coreA.id, "skipped");
  check(skipCore.statusCode === 422 && skipCore.json().error === "core_not_skippable",
    "核心任务跳过被拒（目标图按 core 生成，跳过会让图与计划脱节）");
  const skipOpt = await post(opt.id, "skipped");
  check(skipOpt.statusCode === 200, "可选任务可以跳过");

  console.log("\n=== 8.4 guided_selection 的两条独立状态轴（决策 14）===");
  const doneBeforeSelect = await post(guided.id, "done");
  check(doneBeforeSelect.statusCode === 422 && doneBeforeSelect.json().error === "selection_required",
    "未选定就标完成被拒（不知道做了哪个方案，写不出正确账本）");

  const sel = await app.inject({ method: "POST", url: `/plans/${plan.id}/tasks/${guided.id}/select`, headers: { cookie }, payload: { styleTag: "寸头" } });
  const g1 = await prisma.stageTask.findUnique({ where: { id: guided.id } });
  check(sel.statusCode === 200 && g1?.selectionStatus === "selected" && g1?.status === "pending",
    "选定只改 selectionStatus，status 保持 pending", `selection=${g1?.selectionStatus} status=${g1?.status}`);
  const entriesAfterSelect = await prisma.changeManifestEntry.count({ where: { planId: plan.id } });
  check(entriesAfterSelect === 0, "选定**不写账本**（决策完成 ≠ 真实变化已发生）", `账本条目=${entriesAfterSelect}`);

  const badTag = await app.inject({ method: "POST", url: `/plans/${plan.id}/tasks/${guided.id}/select`, headers: { cookie }, payload: { styleTag: "不存在的发型" } });
  check(badTag.statusCode === 422, "候选外的 tag 被拒");

  console.log("\n=== 8.3 完成才写账本，且用选中候选的描述 ===");
  await post(coreA.id, "done");
  const e1 = await prisma.changeManifestEntry.findFirst({ where: { sourceTaskId: coreA.id } });
  check(Boolean(e1) && e1?.changeDescription === "胡须剃干净", "simple 任务完成 → 写账本（无 LLM 调用）");
  check(e1?.verificationStatus === "unverified", "自报完成默认 unverified，等 progress_recheck 校准（决策 13）");

  console.log("\n=== 8.5 解锁实时判定 ===");
  const beforeUnlock = await progression.evaluateStageUnlock(st0.id);
  check(!beforeUnlock.allCoreDone && beforeUnlock.coreDone === 1 && beforeUnlock.coreTotal === 2,
    "还有 core 未完成 → 不解锁（尽管 optional 已跳过）", `core ${beforeUnlock.coreDone}/${beforeUnlock.coreTotal}`);

  const unlockResp = await post(coreB.id, "done");
  const ur = unlockResp.json();
  check(ur.stageUnlocked === true && ur.unlockedStageIndex === 1, "全部 core 完成 → 解锁下一阶段", `解锁到阶段${ur.unlockedStageIndex}`);
  const st0After = await prisma.stage.findUnique({ where: { id: st0.id } });
  const st1After = await prisma.stage.findUnique({ where: { id: st1.id } });
  check(st0After?.status === "completed" && st1After?.status === "active", "阶段状态正确流转", `阶段0=${st0After?.status} 阶段1=${st1After?.status}`);
  const unlockJob = await prisma.analysisJob.findFirst({ where: { planId: plan.id, jobType: "stage_unlock_generation" } });
  check(Boolean(unlockJob), "解锁后追加目标图生成 job（tasks 7.6），但解锁本身已完成不受其阻塞");

  console.log("\n=== 决策 4：目标图输入口径 ===");
  const input = await progression.buildTargetImageInput(plan.id, st1.id);
  check(input?.baselinePhotoId === photo.id, "基准照片恒为最初正面照（禁用上阶段生成图，防身份漂移）");
  check(input?.seed === 777, "使用 per-user 固定 seed（保证四阶段图像连贯）", `seed=${input?.seed}`);
  check(input?.completedChanges.length === 2, "已完成账本含阶段0 的 2 条", input?.completedChanges.join(" / "));
  check(input?.plannedChanges.length === 1 && input?.plannedChanges[0] === "剪成清爽寸头",
    "本阶段 core 计划变化用**选中候选**的描述（不是任务级占位）", input?.plannedChanges[0]);
  console.log(`     合并指令：${input?.instruction}`);
  check(input!.instruction.includes("1.") && input!.instruction.includes("3."), "编号列表格式（实测比逗号串联效果好）");

  console.log("\n=== 8.1 方案读取 ===");
  const cur = await app.inject({ method: "GET", url: "/plans/current", headers: { cookie } });
  const cj = cur.json();
  check(cur.statusCode === 200 && cj.stages.length === 4, "一次返回全部四阶段（不再有「未生成阶段只给骨架」）", `${cj.stages.length} 阶段`);
  check(cj.stages[0].coreProgress.allDone === true, "阶段进度实时算出");
  const guidedInPayload = cj.stages[1].tasks.find((t: any) => t.taskType === "guided_selection");
  check(guidedInPayload?.skippable === false, "core 任务带 skippable:false（前端不该给出点了就报错的按钮）");
  check(cj.stages[1].targetImages.every((i: any) => i.disclosure?.includes("模拟效果")) || cj.stages[1].targetImages.length === 0,
    "目标图带「基于你勾选的完成情况」标注（tasks 8.9）");

  await prisma.user.delete({ where: { id: user.id } });
  console.log(`\n${fail === 0 ? "全部通过" : "有失败项"}：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exit(1);
} finally { await app.close(); }
