import "dotenv/config";
import { createContainer } from "../app/container.js";
import { buildApp } from "../app/server.js";
import { SESSION_COOKIE_NAME } from "../services/sessionService.js";
import { createDataDeletionService } from "../services/dataDeletionService.js";
import { createPhotoAccessService } from "../services/photoAccessService.js";
import { embedPngMetadata, buildAiMetadata, buildDisclosure } from "../lib/aiContentLabel.js";

/**
 * 第 10 节验证。重点断言：
 *   - 删除是「受理」而非「完成」，文案如实
 *   - 分级删除各自独立（派生特征可单删而不动照片）
 *   - 日志脱敏**只影响本用户**（我实现时踩过这个 bug）
 *   - 撤回人脸同意连带受理照片删除
 *   - AI 标识：显式 + 隐式（PNG 元数据可读回）
 */
const container = createContainer();
const app = await buildApp({ container, logger: false });
const prisma = container.prisma;
const deletion = createDataDeletionService(prisma);
const access = createPhotoAccessService(prisma);
let pass = 0, fail = 0;
const check = (ok: boolean, label: string, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "✅" : "❌"} ${label}${detail ? `  ${detail}` : ""}`); };

try {
  console.log("=== 10.3 AI 生成内容标识 ===");
  const disclosure = buildDisclosure({ isSimulated: true, basedOnSelfReported: true });
  check(disclosure.includes("AI生成") && disclosure.includes("勾选"), "显式标识含 AI 生成 + 自报依据", disclosure);

  // PNG 隐式标识的完整验证在 test-png-metadata.ts（需要结构合法的 PNG fixture，
  // 全零字节的假 IHDR 会让 chunk 遍历错位——这是我第一版测试踩的坑）。
  // 这里只做冒烟检查：非 PNG 输入不被破坏。
  const meta = buildAiMetadata({ provider: "volcengine", planId: "p1" });
  check(Boolean(meta["AI-Generated"]) && Boolean(meta["AI-Provider"]), "AI 元数据集含生成标记与供应商");
  const notPng = embedPngMetadata(Buffer.from("not a png"), meta);
  check(notPng.toString() === "not a png", "非 PNG 原样返回（不破坏数据）");

  console.log("\n=== 10.1 分级删除受理语义 ===");
  const s = await app.inject({ method: "POST", url: "/auth/device-session" });
  const sid = s.json().deviceSessionId as string;
  const cookie = `${SESSION_COOKIE_NAME}=${sid}`;
  const user = (await prisma.user.findUnique({ where: { deviceSessionId: sid } }))!;

  const p1 = await prisma.userPhoto.create({ data: { userId: user.id, photoType: "front", storageKey: `raw/${user.id}/a.jpg`, faceMetrics: { classification: { faceShape: { value: "round" } } } } });
  const p2 = await prisma.userPhoto.create({ data: { userId: user.id, photoType: "full_body", storageKey: `raw/${user.id}/b.jpg` } });

  const del1 = await app.inject({ method: "DELETE", url: `/me/photos/${p1.id}`, headers: { cookie } });
  const dj = del1.json();
  check(del1.statusCode === 202, "删除返回 202 Accepted 而非 200 OK（语义是受理）", `HTTP ${del1.statusCode}`);
  check(dj.status === "pending" && dj.notice.includes("已受理"), "文案如实说「已受理」不说「已删除」", dj.notice.slice(0, 40));
  check(dj.affectedCount === 1, "告知影响范围", `${dj.affectedCount} 条`);
  const afterMark = await prisma.userPhoto.findUnique({ where: { id: p1.id } });
  check(afterMark?.deletionStatus === "pending", "照片标记 pending 但记录仍在（等队列清理）");

  console.log("\n=== 派生特征可单删而不动照片 ===");
  const dfResult = await deletion.executeDeletion(user.id, { kind: "derived_features" });
  const afterDf = await prisma.userPhoto.findUnique({ where: { id: p1.id } });
  check(afterDf?.faceMetrics === null && afterDf !== null, "faceMetrics 清空但照片记录保留", `faceMetrics=${afterDf?.faceMetrics}`);

  console.log("\n=== 日志脱敏只影响本用户（我实现时踩过的 bug）===");
  const otherUser = await prisma.user.create({ data: { deviceSessionId: `other-${Date.now()}` } });
  const otherPlan = await prisma.appearancePlan.create({ data: { userId: otherUser.id, track: "short_term", generationSeed: 1, stages: { create: [{ stageIndex: 0, windowLabel: "S0", status: "active", unlockRule: {} }] } }, include: { stages: true } });
  const otherPhoto = await prisma.userPhoto.create({ data: { userId: otherUser.id, photoType: "front", storageKey: `raw/${otherUser.id}/x.jpg` } });
  await prisma.providerCallLog.create({ data: { callId: "other-user-call", provider: "volcengine", reqKey: "seededit_v3.0", requestSummary: { prompt: "别人的调用" } } });
  await prisma.targetImage.create({ data: { planId: otherPlan.id, stageId: otherPlan.stages[0].id, imageType: "face_hair", baselinePhotoId: otherPhoto.id, manifestSnapshot: [], plannedChangesSnapshot: [], providerCallId: "other-user-call" } });

  const myPlan = await prisma.appearancePlan.create({ data: { userId: user.id, track: "short_term", generationSeed: 2, stages: { create: [{ stageIndex: 0, windowLabel: "S0", status: "active", unlockRule: {} }] } }, include: { stages: true } });
  await prisma.providerCallLog.create({ data: { callId: "my-call", provider: "volcengine", reqKey: "seededit_v3.0", requestSummary: { prompt: "我的调用" } } });
  await prisma.targetImage.create({ data: { planId: myPlan.id, stageId: myPlan.stages[0].id, imageType: "face_hair", baselinePhotoId: p2.id, manifestSnapshot: [], plannedChangesSnapshot: [], providerCallId: "my-call" } });

  await deletion.executeDeletion(user.id, { kind: "account" });
  const myLog = await prisma.providerCallLog.findUnique({ where: { callId: "my-call" } });
  const otherLog = await prisma.providerCallLog.findUnique({ where: { callId: "other-user-call" } });
  check((myLog?.requestSummary as any)?.redacted === true, "本用户的调用日志被脱敏");
  check((otherLog?.requestSummary as any)?.prompt === "别人的调用", "**其他用户的日志未被波及**（按 callId 精确定位）");
  check(Boolean(myLog) && Boolean(otherLog), "调用记录本身保留（成本统计需要）");
  const userGone = await prisma.user.findUnique({ where: { id: user.id } });
  check(userGone === null, "账号删除生效（Cascade 带走关联数据）");

  console.log("\n=== 10.4 访问日志 ===");
  const u2 = await prisma.user.create({ data: { deviceSessionId: `log-${Date.now()}` } });
  const lp = await prisma.userPhoto.create({ data: { userId: u2.id, photoType: "front", storageKey: `raw/${u2.id}/c.jpg` } });
  await access.issueReadUrl({ storageKey: lp.storageKey, photoId: lp.id, accessorType: "user", accessorId: u2.id, purpose: "用户查看自己的照片" });
  await access.issueReadUrl({ storageKey: lp.storageKey, photoId: lp.id, accessorType: "staff_review", accessorId: "staff-01", purpose: "人工内容审核", expiresSeconds: 1800 });
  await access.issueReadUrl({ storageKey: lp.storageKey, photoId: lp.id, accessorType: "system_provider", purpose: "交付 img2img 供应商" });

  const history = await access.getAccessHistory(lp.id);
  check(history.length === 3, "三类访问都被记录", `${history.length} 条`);
  const staffLogs = await access.getStaffAccessHistory();
  check(staffLogs.some((l) => l.accessorId === "staff-01"), "后台人工审核可单独查询（合规最关心的场景）");
  check(staffLogs.find((l) => l.accessorId === "staff-01")?.expiresInSeconds === 1800,
    "记录暴露窗口大小（一次签发在有效期内可反复读取）", "1800s");

  console.log("\n=== 撤回人脸同意连带删除 ===");
  const s2 = await app.inject({ method: "POST", url: "/auth/device-session" });
  const c2 = `${SESSION_COOKIE_NAME}=${s2.json().deviceSessionId}`;
  const u3 = (await prisma.user.findUnique({ where: { deviceSessionId: s2.json().deviceSessionId } }))!;
  await prisma.userPhoto.create({ data: { userId: u3.id, photoType: "front", storageKey: `raw/${u3.id}/d.jpg` } });
  const consent = await prisma.consentRecord.create({ data: { userId: u3.id, consentType: "face_processing", version: "v1" } });

  const revoke = await app.inject({ method: "POST", url: `/me/consents/${consent.id}/revoke`, headers: { cookie: c2 } });
  const rj = revoke.json();
  check(revoke.statusCode === 200 && rj.photoDeletionAccepted === true,
    "撤回人脸处理同意 → 连带受理照片删除（不能只撤同意却留着数据）");
  check(rj.notice.includes("同时受理"), "文案说清连带效果", rj.notice);
  const revokeAgain = await app.inject({ method: "POST", url: `/me/consents/${consent.id}/revoke`, headers: { cookie: c2 } });
  check(revokeAgain.json().alreadyRevoked === true, "重复撤回幂等");

  await prisma.user.deleteMany({ where: { id: { in: [otherUser.id, u2.id, u3.id] } } });
  await prisma.providerCallLog.deleteMany({ where: { callId: { in: ["my-call", "other-user-call"] } } });
  console.log(`\n${fail === 0 ? "全部通过" : "有失败项"}：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exit(1);
} finally { await app.close(); }
