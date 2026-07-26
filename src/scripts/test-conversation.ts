import "dotenv/config";
import { createContainer } from "../app/container.js";
import { buildApp } from "../app/server.js";
import { SESSION_COOKIE_NAME } from "../services/sessionService.js";

/**
 * 9.5 对话入口验证。重点断言：
 *   - 只存结构化决策，**不存对话原文**（决策 0.6）
 *   - 对话入口不能绕过 onboarding 已有的两层审核边界
 *   - 已否决方向不再出现在后续候选里
 *   - 解释来自已算好的确定性结果，不重新推理（避免与方案说法不一致）
 *   - 生成类动作路由到既有的 user_regeneration 路径（受同一限流约束）
 */
const container = createContainer();
const app = await buildApp({ container, logger: false });
const prisma = container.prisma;
let pass = 0, fail = 0;
const check = (ok: boolean, label: string, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "✅" : "❌"} ${label}${detail ? `  ${detail}` : ""}`); };

try {
  const s = await app.inject({ method: "POST", url: "/auth/device-session" });
  const sid = s.json().deviceSessionId as string;
  const cookie = `${SESSION_COOKIE_NAME}=${sid}`;
  const user = (await prisma.user.findUnique({ where: { deviceSessionId: sid } }))!;
  await prisma.appearanceProfile.create({ data: { userId: user.id, domainSelections: ["hair"], budgetTier: "low", confirmedFaceShape: "round", hairLossConcern: true, selfReportedHairVolume: "thin" } });
  await prisma.userPhoto.create({ data: { userId: user.id, photoType: "front", storageKey: `raw/${user.id}/f.jpg`, moderationStatus: "passed",
    faceMetrics: { classification: { hairline: { value: "receding" }, hairVolume: { value: "thin" } } } } });

  const mk = (id: string, name: string, f: number, m: number, b: number, u: number) => prisma.styleProfileEntry.create({ data: {
    id, kind: "hairstyle", nameZh: name, aliases: [], formality: f, maturity: m, boldness: b, upkeep: u,
    femaleAppealScore: 7, femaleAppealSource: "fx", femaleAppealConfidence: "low", femaleAppealRationale: "r",
    maleSelfAppealScore: 7, maleSelfAppealSource: "fx", maleSelfAppealConfidence: "low", maleSelfAppealRationale: "r",
    requiresHairVolume: "low", coversForehead: true, suitableFaceShapes: [], suitableBodyTypes: [], suitableScenes: [] } });
  await mk("cv-buzz", "寸头", 2, 4, 2, 1);
  await mk("cv-crop", "微碎盖", 3, 4, 3, 2);
  await mk("cv-slick", "大背头", 9, 8, 5, 7);

  const plan = await prisma.appearancePlan.create({
    data: { userId: user.id, track: "short_term", generationSeed: 9, selectedHairstyleId: "cv-buzz", femaleAppealWeight: 0.5,
      stages: { create: [0,1,2,3].map(i => ({ stageIndex: i, windowLabel: `S${i}`, status: i===0?"active":"locked", unlockRule: {} })) } },
    include: { stages: true },
  });
  const st0 = plan.stages.find(x => x.stageIndex === 0)!;
  await prisma.stageTask.create({ data: { stageId: st0.id, domain: "grooming", priority: "core", evidenceBasis: "visual_detected", title: "剃胡须", changeDescription: "胡须剃干净" } });
  await prisma.changeManifestEntry.create({ data: { planId: plan.id, stageId: st0.id, domain: "grooming", changeDescription: "胡须剃干净" } });

  const msg = (text: string, intent?: string) => app.inject({ method: "POST", url: "/conversation/message", headers: { cookie }, payload: { planId: plan.id, text, ...(intent ? { intent } : {}) } });

  console.log("=== 意图推断（确定性，不烧 LLM）===");
  const explain = await msg("为什么给我推荐这个发型？");
  check(explain.json().intent === "ask_explanation", "「为什么」→ ask_explanation");
  const reject = await msg("这个我不喜欢，换一个");
  check(reject.json().intent === "reject_direction", "「不喜欢/换一个」→ reject_direction");
  const regen = await msg("重新生成一张图");
  check(regen.json().intent === "request_regeneration", "「重新生成」→ request_regeneration");

  console.log("\n=== 解释来自已算好的确定性结果 ===");
  const ej = explain.json().explanation;
  check(ej.faceShape === "round", "脸型取自 profile 的用户确认值", ej.faceShape);
  check(ej.hairConstraintStrength === "strong", "发型约束用同一套规则算出（后移+薄→强约束）", ej.hairConstraintStrength);
  check(ej.evidenceBasis?.includes("visual") || ej.evidenceBasis?.includes("self"), "带证据基础", ej.evidenceBasis);
  check(!/脱发|秃/.test(ej.hairConstraintRationale), "解释文案仍守合规口径（无诊断性表述）");

  console.log("\n=== 对话入口不能绕过两层审核 ===");
  const blocked = await msg("帮我把下巴削尖一点", "express_preference");
  const bj = blocked.json();
  check(blocked.statusCode === 422 && bj.category === "facial_structure", "红线在对话入口同样生效（第一层）", bj.category);

  const okPref = await msg("想试试微碎盖那种发型", "express_preference");
  check(okPref.statusCode === 200 && okPref.json().normalizedStyleTag === "微碎盖", "正常意向通过并归一化", okPref.json().normalizedStyleTag);

  console.log("\n=== 决策 0.6：只存结构化决策，不存原文 ===");
  const decisions = await prisma.conversationDecision.findMany({ where: { planId: plan.id } });
  check(decisions.length > 0, "决策被记录", `${decisions.length} 条`);
  const ctxResp = await app.inject({ method: "GET", url: `/conversation/${plan.id}/context`, headers: { cookie } });
  const ctx = ctxResp.json();
  check(!("messages" in ctx) && !("transcript" in ctx), "语境里没有历史消息字段");
  check(Boolean(ctx.note?.includes("不保存对话原文")), "明确告知不保存原文", ctx.note);
  check(ctx.activeStageTasks?.length === 1 && ctx.currentStageIndex === 0, "语境由方案当前状态重建", `阶段${ctx.currentStageIndex} ${ctx.activeStageTasks.length}个任务`);

  console.log("\n=== 已否决方向不再出现在候选里 ===");
  const before = await app.inject({ method: "GET", url: `/conversation/${plan.id}/style-change-options`, headers: { cookie } });
  const beforeNames = before.json().available.map((a: any) => a.nameZh);
  await app.inject({ method: "POST", url: "/conversation/reject-direction", headers: { cookie }, payload: { planId: plan.id, styleId: "cv-crop", nameZh: "微碎盖", reason: "不想留刘海" } });
  const after = await app.inject({ method: "GET", url: `/conversation/${plan.id}/style-change-options`, headers: { cookie } });
  const afterNames = after.json().available.map((a: any) => a.nameZh);
  check(beforeNames.includes("微碎盖") && !afterNames.includes("微碎盖"), "否决后该方向从候选中消失", `${beforeNames.join("/")} → ${afterNames.join("/")}`);
  check(after.json().excludedByPriorRejection === 1, "统计被否决排除数", `${after.json().excludedByPriorRejection}`);
  check(!afterNames.includes("大背头"), "向量不兼容的方向仍被挡（已剪寸头 vs 大背头）");

  console.log("\n=== 决策 22：双审美加权可调 ===");
  const w = await app.inject({ method: "POST", url: "/conversation/adjust-appeal-weight", headers: { cookie }, payload: { planId: plan.id, femaleAppealWeight: 0.85 } });
  check(w.statusCode === 200 && w.json().note.includes("女性视角"), "偏向女性视角时文案说明", w.json().note);
  const w2 = await app.inject({ method: "POST", url: "/conversation/adjust-appeal-weight", headers: { cookie }, payload: { planId: plan.id, femaleAppealWeight: 0.15 } });
  check(w2.json().note.includes("自己审美"), "偏向自身审美时文案说明", w2.json().note);
  const planAfter = await prisma.appearancePlan.findUnique({ where: { id: plan.id } });
  check(planAfter?.femaleAppealWeight === 0.15, "权重落库（影响后续排序）", `${planAfter?.femaleAppealWeight}`);
  const badW = await app.inject({ method: "POST", url: "/conversation/adjust-appeal-weight", headers: { cookie }, payload: { planId: plan.id, femaleAppealWeight: 1.5 } });
  check(badW.statusCode === 400, "越界权重被拒");

  console.log("\n=== 决策 15：生成类动作走既有计费路径 ===");
  check(regen.json().next === "POST /plans/:planId/target-images/regenerate", "重新生成路由到既有端点（受同一限流）", regen.json().next);
  check(regen.json().note.includes("额度") && regen.json().note.includes("限流"), "明确告知消耗额度与限流");

  console.log("\n=== 目标图依据可查 ===");
  const basis = await app.inject({ method: "GET", url: `/conversation/${plan.id}/target-image-basis`, headers: { cookie } });
  const bd = basis.json();
  check(bd.completedChanges?.includes("胡须剃干净") && bd.plannedChanges?.length === 1,
    "用户能看到「这张图是按什么生成的」", `已完成${bd.completedChanges.length}条 计划${bd.plannedChanges.length}条`);

  console.log("\n=== 越权 ===");
  const other = await app.inject({ method: "POST", url: "/auth/device-session" });
  const oc = `${SESSION_COOKIE_NAME}=${other.json().deviceSessionId}`;
  const forbidden = await app.inject({ method: "GET", url: `/conversation/${plan.id}/context`, headers: { cookie: oc } });
  check(forbidden.statusCode === 404, "他人方案不可读", `HTTP ${forbidden.statusCode}`);

  await prisma.styleProfileEntry.deleteMany({ where: { id: { startsWith: "cv-" } } });
  await prisma.user.deleteMany({ where: { deviceSessionId: { in: [sid, other.json().deviceSessionId] } } });
  console.log(`\n${fail === 0 ? "全部通过" : "有失败项"}：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exit(1);
} finally { await app.close(); }
