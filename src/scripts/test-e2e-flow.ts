import "dotenv/config";
import { createContainer } from "../app/container.js";
import { buildApp } from "../app/server.js";
import { SESSION_COOKIE_NAME } from "../services/sessionService.js";
import { materializePlanStep, type MaterializeTaskSpec } from "../steps/materializePlan.js";
import { createStageProgressionService } from "../services/stageProgressionService.js";
import { createPlanRevisionService } from "../services/planRevisionService.js";
import { createDataDeletionService } from "../services/dataDeletionService.js";

/**
 * 11.1 端到端流程验证。
 *
 * 这个测试的价值不在于覆盖每个分支（那是各节单元测试的事），而在于发现
 * **各部分单独正确、连起来不对**的问题：状态在步骤之间是否正确传递、
 * 前一步的产出是否满足后一步的前置条件、跨服务的一致性约束是否成立。
 *
 * 不打真实图片生成 API（那部分在 11.2-11.5 单独验，每次 ¥0.2）。
 * 这里验的是业务流转本身。
 */
const container = createContainer();
const app = await buildApp({ container, logger: false });
const prisma = container.prisma;
const progression = createStageProgressionService(prisma);
const revision = createPlanRevisionService(prisma);
const deletion = createDataDeletionService(prisma);

let pass = 0, fail = 0;
let step = 0;
const check = (ok: boolean, label: string, detail = "") => { ok ? pass++ : fail++; console.log(`   ${ok ? "✅" : "❌"} ${label}${detail ? `  ${detail}` : ""}`); };
const stage = (name: string) => console.log(`\n【${++step}】${name}`);

try {
  // ─────────────────────────────────────────────
  stage("匿名会话");
  const s = await app.inject({ method: "POST", url: "/auth/device-session" });
  const sid = s.json().deviceSessionId as string;
  const cookie = `${SESSION_COOKIE_NAME}=${sid}`;
  check(s.statusCode === 201, "签发会话");
  const user = (await prisma.user.findUnique({ where: { deviceSessionId: sid } }))!;

  // ─────────────────────────────────────────────
  stage("问卷（含脱发自报与体型细项）");
  await app.inject({ method: "POST", url: "/questionnaire/basic", headers: { cookie }, payload: { track: "short_term", ageConfirmed18Plus: true } });
  const full = await app.inject({ method: "POST", url: "/questionnaire/full", headers: { cookie },
    payload: { heightCm: 176, weightKg: 70, shoulderWidthCm: 44, waistCm: 78, exercisesRegularly: false,
      selfReportedHairVolume: "thin", hairLossConcern: true, domainSelections: ["hair", "outfit"], budgetTier: "low" } });
  check(full.statusCode === 200, "问卷提交", `矛盾项 ${full.json().contradictions.length} 个`);

  // ─────────────────────────────────────────────
  stage("人脸处理同意 + 照片（带客户端 FaceMetrics）");
  await app.inject({ method: "POST", url: "/photos/consent", headers: { cookie }, payload: { consentType: "face_processing", version: "v1.0" } });
  const frontReg = await app.inject({ method: "POST", url: "/photos", headers: { cookie },
    payload: { photoType: "front", storageKey: `raw/${user.id}/front.jpg`,
      faceMetrics: { classification: {
        faceShape: { value: "oblong", confidence: "high", evidence: { lengthWidthRatio: 1.34 } },
        hairline: { value: "receding" }, hairVolume: { value: "thin" } } } } });
  check(frontReg.statusCode === 201, "正面照登记 + FaceMetrics 落库");
  await prisma.userPhoto.updateMany({ where: { userId: user.id }, data: { moderationStatus: "passed" } });

  // ─────────────────────────────────────────────
  stage("脸型确认（客户端测量 → 用户修正）");
  const computed = await app.inject({ method: "GET", url: "/face-shape/computed", headers: { cookie } });
  check(computed.json().faceShape === "oblong" && computed.json().evidence.lengthWidthRatio === 1.34,
    "读到客户端几何结论 + 支撑比值", `${computed.json().faceShape} ratio=${computed.json().evidence.lengthWidthRatio}`);
  await app.inject({ method: "POST", url: "/face-shape/confirm", headers: { cookie }, payload: { confirmedFaceShape: "oblong" } });

  // ─────────────────────────────────────────────
  stage("发型意向（两层审核）");
  const intent = await app.inject({ method: "POST", url: "/intake/hair-intent", headers: { cookie },
    payload: { hasPreference: true, preferenceText: "想剪个碎盖，显得精神一点" } });
  check(intent.statusCode === 200 && intent.json().normalizedStyleTag === "微碎盖", "意向过审并归一化", intent.json().normalizedStyleTag);

  // ─────────────────────────────────────────────
  stage("触发 initial_analysis");
  const job = await app.inject({ method: "POST", url: "/analysis-jobs", headers: { cookie } });
  check(job.statusCode === 202, "前置齐备后入队", `HTTP ${job.statusCode}`);
  const jobId = job.json().jobId as string;
  const dup = await app.inject({ method: "POST", url: "/analysis-jobs", headers: { cookie } });
  check(dup.json().reused === true, "重复触发复用在途 job（不重复烧钱）");

  // ─────────────────────────────────────────────
  stage("渐进式部分结果可读");
  const jobs = (await import("../repositories/analysisJobRepository.js")).createAnalysisJobRepository(prisma);
  await jobs.transition(jobId, "recommending");
  await jobs.mergePartialResult(jobId, { textRecommendations: [{ nameZh: "微碎盖", score: 8.5 }, { nameZh: "寸头", score: 6.2 }] });
  const poll = await app.inject({ method: "GET", url: `/analysis-jobs/${jobId}`, headers: { cookie } });
  check(poll.json().terminal === false && poll.json().partialResult.textRecommendations.length === 2,
    "非终态即可读文字推荐", `status=${poll.json().status}`);

  // ─────────────────────────────────────────────
  stage("建立方案 + 选发型（第一步：不可逆决策）");
  const mkStyle = (id: string, name: string, f: number, m: number, b: number, u: number, vol: "low"|"medium"|"high", covers: boolean) =>
    prisma.styleProfileEntry.create({ data: { id, kind: "hairstyle", nameZh: name, aliases: [], formality: f, maturity: m, boldness: b, upkeep: u,
      femaleAppealScore: 8, femaleAppealSource: "fx", femaleAppealConfidence: "low", femaleAppealRationale: "r",
      maleSelfAppealScore: 7, maleSelfAppealSource: "fx", maleSelfAppealConfidence: "low", maleSelfAppealRationale: "r",
      requiresHairVolume: vol, coversForehead: covers, suitableFaceShapes: [], suitableBodyTypes: [], suitableScenes: [] } });
  await mkStyle("e2e-crop", "微碎盖", 3, 4, 3, 2, "medium", true);
  await mkStyle("e2e-buzz", "寸头", 2, 4, 2, 1, "low", true);
  await mkStyle("e2e-slick", "大背头", 9, 8, 5, 7, "low", false);

  const plan = await prisma.appearancePlan.create({
    data: { userId: user.id, track: "short_term", generationSeed: 20260726, femaleAppealWeight: 0.6,
      stages: { create: [0,1,2,3].map(i => ({ stageIndex: i, windowLabel: "", status: "locked", unlockRule: { require_all_core_tasks: true } })) } },
    include: { stages: { orderBy: { stageIndex: "asc" } } },
  });

  const noHair = await app.inject({ method: "POST", url: `/plans/${plan.id}/outfit-previews`, headers: { cookie } });
  check(noHair.statusCode === 422, "未选发型时穿搭预览被拒（两步依赖）");

  await prisma.appearancePlan.update({ where: { id: plan.id }, data: { selectedHairstyleId: "e2e-crop" } });
  const withHair = await app.inject({ method: "POST", url: `/plans/${plan.id}/outfit-previews`, headers: { cookie } });
  check(withHair.statusCode === 202, "选定发型后穿搭预览可触发");

  // ─────────────────────────────────────────────
  stage("选穿搭 → 落地方案（S5）");
  await prisma.appearancePlan.update({ where: { id: plan.id }, data: { selectedOutfitId: "e2e-outfit-1" } });
  const matJob = await prisma.analysisJob.create({ data: { userId: user.id, planId: plan.id, jobType: "plan_materialization" } });
  const tasks: MaterializeTaskSpec[] = [
    { domain: "grooming", title: "剃干净胡须", applicableStageRange: ["stage0"], evidenceBasis: "visual_detected",
      changeDescription: "胡须剃干净", estTime: "10分钟", dimensions: { visualBenefit: 5, credibility: 9, acceptance: 9, reversibility: 9, timeCost: 1, moneyCost: 1, risk: 1 } },
    { domain: "other", title: "使用止汗露", applicableStageRange: ["stage0"], evidenceBasis: "general_best_practice",
      changeDescription: "体味管理", dimensions: { visualBenefit: 10, credibility: 9, acceptance: 9, reversibility: 9, timeCost: 1, moneyCost: 1, risk: 1 } },
    { domain: "hair", title: "去理发店剪成选定的发型", applicableStageRange: ["stage1"], evidenceBasis: "visual_detected",
      changeDescription: "发型改变（占位）", estTime: "1小时",
      dimensions: { visualBenefit: 9, credibility: 8, acceptance: 7, reversibility: 4, timeCost: 3, moneyCost: 3, risk: 2 },
      candidateOptions: [{ styleTag: "微碎盖", changeDescription: "剪成微碎盖，前额留碎发遮盖发际线" }, { styleTag: "寸头", changeDescription: "剪成清爽寸头" }] },
    { domain: "fitness", title: "系统减脂训练", applicableStageRange: ["stage3"], evidenceBasis: "self_reported",
      changeDescription: "体型更精练", dimensions: { visualBenefit: 10, credibility: 7, acceptance: 5, reversibility: 8, timeCost: 9, moneyCost: 4, risk: 3 } },
  ];
  const mat = await materializePlanStep.run({ planId: plan.id, tasks }, { jobId: matJob.id, userId: user.id, planId: plan.id }, { prisma, providers: container.providers });
  check(mat.status === "completed", "S5 落地完成");
  const matData = mat.status === "completed" ? mat.data : null;
  check(matData!.stages[0].hasTargetImage === false && matData!.stages[1].hasTargetImage === true, "阶段0 无目标图，阶段1 起才有");
  check(matData!.stages[3].taskCount === 1, "高分长周期任务落阶段3（打分不影响落位）");

  const s0Tasks = await prisma.stageTask.findMany({ where: { stage: { planId: plan.id, stageIndex: 0 } }, orderBy: { sortOrder: "asc" } });
  const deo = s0Tasks.find(t => t.title === "使用止汗露");
  check(deo?.priority === "optional", "general_best_practice 分最高仍强制 optional");

  // ─────────────────────────────────────────────
  stage("方案读取（一次拿全四阶段）");
  const cur = await app.inject({ method: "GET", url: "/plans/current", headers: { cookie } });
  check(cur.statusCode === 200 && cur.json().stages.length === 4, "四阶段全返回");
  check(cur.json().stages[0].tasks.every((t: any) => typeof t.skippable === "boolean"), "任务带 skippable 标记");

  // ─────────────────────────────────────────────
  stage("阶段0 推进 → 解锁阶段1");
  const shave = s0Tasks.find(t => t.title === "剃干净胡须")!;
  const skipCore = await app.inject({ method: "POST", url: `/plans/${plan.id}/tasks/${shave.id}/status`, headers: { cookie }, payload: { status: "skipped" } });
  check(skipCore.statusCode === 422, "核心任务不可跳过");

  const doneResp = await app.inject({ method: "POST", url: `/plans/${plan.id}/tasks/${shave.id}/status`, headers: { cookie }, payload: { status: "done" } });
  const dj = doneResp.json();
  check(dj.manifestEntryCreated === true, "完成即写账本（无 LLM）");
  check(dj.stageUnlocked === true && dj.unlockedStageIndex === 1, "全部 core 完成 → 解锁阶段1", `→ 阶段${dj.unlockedStageIndex}`);
  const unlockJob = await prisma.analysisJob.findFirst({ where: { planId: plan.id, jobType: "stage_unlock_generation" } });
  check(Boolean(unlockJob), "解锁后追加目标图 job（解锁不受其阻塞）");

  // ─────────────────────────────────────────────
  stage("阶段1 guided_selection 两条状态轴");
  const hairTask = await prisma.stageTask.findFirst({ where: { stage: { planId: plan.id, stageIndex: 1 }, taskType: "guided_selection" } })!;
  const doneBefore = await app.inject({ method: "POST", url: `/plans/${plan.id}/tasks/${hairTask!.id}/status`, headers: { cookie }, payload: { status: "done" } });
  check(doneBefore.statusCode === 422 && doneBefore.json().error === "selection_required", "未选定不可标完成");

  await app.inject({ method: "POST", url: `/plans/${plan.id}/tasks/${hairTask!.id}/select`, headers: { cookie }, payload: { styleTag: "微碎盖" } });
  const afterSel = await prisma.stageTask.findUnique({ where: { id: hairTask!.id } });
  const entriesBefore = await prisma.changeManifestEntry.count({ where: { planId: plan.id } });
  check(afterSel?.selectionStatus === "selected" && afterSel?.status === "pending", "选定只改 selectionStatus");
  check(entriesBefore === 1, "选定不写账本（仍只有阶段0 那 1 条）", `${entriesBefore} 条`);

  // ─────────────────────────────────────────────
  stage("目标图输入口径（决策 4 的核心）");
  const st1 = plan.stages.find(x => x.stageIndex === 1)!;
  const basis = await progression.buildTargetImageInput(plan.id, st1.id);
  check(basis?.seed === 20260726, "使用 per-user 固定 seed");
  check(basis?.completedChanges.length === 1 && basis?.plannedChanges[0] === "剪成微碎盖，前额留碎发遮盖发际线",
    "已完成账本 + 本阶段 core 计划（用选中候选的描述）", basis?.plannedChanges[0]);
  console.log(`      合并指令：${basis?.instruction}`);

  // ─────────────────────────────────────────────
  stage("完成发型任务 → 账本用选中候选的描述");
  await app.inject({ method: "POST", url: `/plans/${plan.id}/tasks/${hairTask!.id}/status`, headers: { cookie }, payload: { status: "done" } });
  const hairEntry = await prisma.changeManifestEntry.findFirst({ where: { sourceTaskId: hairTask!.id } });
  check(hairEntry?.changeDescription === "剪成微碎盖，前额留碎发遮盖发际线", "账本写的是选中候选的描述，不是任务级占位");
  check(hairEntry?.verificationStatus === "unverified", "自报完成默认 unverified");

  // ─────────────────────────────────────────────
  stage("progress_recheck 账本校准");
  const recheck = await app.inject({ method: "POST", url: `/plans/${plan.id}/recheck`, headers: { cookie }, payload: { progressPhotoStorageKey: `raw/${user.id}/progress.jpg` } });
  check(recheck.statusCode === 202, "进度照片入队");
  const rec = await revision.reconcileManifest({ planId: plan.id, unverifiedDescriptions: ["剪成微碎盖，前额留碎发遮盖发际线"] });
  check(rec.rolledBack === 1 && rec.verified === 1, "偏差条目回退、一致条目标记 verified", `回退${rec.rolledBack} 确认${rec.verified}`);
  const taskAfterRec = await prisma.stageTask.findUnique({ where: { id: hairTask!.id } });
  check(taskAfterRec?.status === "pending", "回退账本时任务也退回 pending（两边不矛盾）", `done → ${taskAfterRec?.status}`);

  // ─────────────────────────────────────────────
  stage("换风格（受已完成事实约束）");
  const opts = await app.inject({ method: "GET", url: `/conversation/${plan.id}/style-change-options`, headers: { cookie } });
  const availNames = opts.json().available.map((a: any) => a.nameZh);
  check(!availNames.includes("大背头"), "向量不兼容的方向被挡", `可选：${availNames.join("/")}`);
  // 用相对断言而非绝对版本号：校准（第15步）和换风格都会递增，
  // 写死 v2 会在流程新增任何一个版本递增事件时误报。
  const versionBeforeChange = (await prisma.appearancePlan.findUnique({ where: { id: plan.id } }))!.planVersion;
  const changed = await revision.applyStyleChange({ planId: plan.id, newHairstyleId: "e2e-buzz" });
  check(changed.ok && changed.planVersion === versionBeforeChange + 1, "换风格递增 plan_version（相对断言）",
    changed.ok ? `v${versionBeforeChange} → v${changed.planVersion}` : "");
  check(changed.ok && changed.retainedEntries >= 1, "已完成账本保留");

  // ─────────────────────────────────────────────
  stage("对话入口一致性");
  const ctx = await app.inject({ method: "GET", url: `/conversation/${plan.id}/context`, headers: { cookie } });
  const latestVersion = (await prisma.appearancePlan.findUnique({ where: { id: plan.id } }))!.planVersion;
  check(ctx.json().planVersion === latestVersion, "对话语境反映最新 planVersion", `v${ctx.json().planVersion}`);
  const convBlocked = await app.inject({ method: "POST", url: "/conversation/message", headers: { cookie },
    payload: { planId: plan.id, text: "帮我把下巴削尖", intent: "express_preference" } });
  check(convBlocked.statusCode === 422, "对话入口不能绕过红线");

  // ─────────────────────────────────────────────
  stage("删除账号（合规级联）");
  const photoCount = await prisma.userPhoto.count({ where: { userId: user.id } });
  const del = await app.inject({ method: "DELETE", url: "/me", headers: { cookie } });
  check(del.statusCode === 202 && del.json().status === "pending", "返回 202 已受理（非「已删除」）");
  await deletion.executeDeletion(user.id, { kind: "account" });
  check((await prisma.user.findUnique({ where: { id: user.id } })) === null, "账号删除生效");
  check((await prisma.appearancePlan.count({ where: { id: plan.id } })) === 0, "方案级联删除");
  check((await prisma.changeManifestEntry.count({ where: { planId: plan.id } })) === 0, "账本级联删除");
  check((await prisma.conversationDecision.count({ where: { planId: plan.id } })) === 0, "对话决策级联删除");
  console.log(`      删除前有 ${photoCount} 张照片，全部级联清理`);

  await prisma.styleProfileEntry.deleteMany({ where: { id: { startsWith: "e2e-" } } });
  console.log(`\n${fail === 0 ? "端到端全部通过" : "有失败项"}：${pass} 通过 / ${fail} 失败（${step} 个流程节点）`);
  if (fail > 0) process.exit(1);
} finally { await app.close(); }
