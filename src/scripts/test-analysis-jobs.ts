import "dotenv/config";
import { createContainer } from "../app/container.js";
import { buildApp } from "../app/server.js";
import { SESSION_COOKIE_NAME } from "../services/sessionService.js";
import { createAnalysisJobRepository } from "../repositories/analysisJobRepository.js";

/**
 * 第 7 节验证。重点断言：
 *   - 完整性校验逐项说明缺什么，不是笼统"数据不完整"
 *   - 在途 job 复用而非重复入队（重复触发会白烧图片钱）
 *   - 状态机拒绝非法跃迁 / 拒绝回退 / 终态不可再变
 *   - completed_partial 与 completed 区分开
 *   - 轮询在非终态就能读到部分结果
 *   - 容量限流独立于计费
 */
const container = createContainer();
const app = await buildApp({ container, logger: false });
const prisma = container.prisma;
const jobs = createAnalysisJobRepository(prisma);
let pass = 0, fail = 0;
const check = (ok: boolean, label: string, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "✅" : "❌"} ${label}${detail ? `  ${detail}` : ""}`); };

try {
  const s = await app.inject({ method: "POST", url: "/auth/device-session" });
  const sid = s.json().deviceSessionId as string;
  const cookie = `${SESSION_COOKIE_NAME}=${sid}`;
  const user = (await prisma.user.findUnique({ where: { deviceSessionId: sid } }))!;

  console.log("=== 7.2 完整性校验 ===");
  const bare = await app.inject({ method: "POST", url: "/analysis-jobs", headers: { cookie } });
  const bj = bare.json();
  check(bare.statusCode === 422 && bj.error === "data_incomplete", "数据不全时拒绝触发", `HTTP ${bare.statusCode}`);
  const fields = (bj.issues as {field:string}[]).map(i => i.field);
  check(fields.includes("questionnaire") && fields.includes("consent") && fields.includes("frontPhoto"),
    "逐项说明缺什么（不是笼统一句话）", fields.join(", "));

  // 补齐前置条件
  await prisma.appearanceProfile.create({ data: { userId: user.id, domainSelections: ["hair"], budgetTier: "low" } });
  await prisma.consentRecord.create({ data: { userId: user.id, consentType: "face_processing", version: "v1" } });
  const photo = await prisma.userPhoto.create({ data: { userId: user.id, photoType: "front", storageKey: `raw/${user.id}/f.jpg`, moderationStatus: "passed" } });

  const ok1 = await app.inject({ method: "POST", url: "/analysis-jobs", headers: { cookie } });
  const jobId = ok1.json().jobId as string;
  check(ok1.statusCode === 202 && ok1.json().reused === false, "前置齐备后成功入队", `HTTP ${ok1.statusCode}`);

  const ok2 = await app.inject({ method: "POST", url: "/analysis-jobs", headers: { cookie } });
  check(ok2.statusCode === 200 && ok2.json().reused === true && ok2.json().jobId === jobId,
    "在途 job 复用而非重复入队（避免重复烧钱）");

  console.log("\n=== 7.1 状态机 ===");
  const t1 = await jobs.transition(jobId, "input_moderating");
  check(t1.ok, "created → input_moderating 合法");
  const t2 = await jobs.transition(jobId, "created");
  check(!t2.ok, "拒绝回退（重跑应新建 job 而非复用）", t2.ok ? "" : t2.reason);
  const t3 = await jobs.transition(jobId, "materializing");
  check(!t3.ok, "拒绝 initial_analysis 不经过的状态", t3.ok ? "" : t3.reason.slice(0, 60));
  const t4 = await jobs.transition(jobId, "rendering");
  check(t4.ok, "允许向前跳跃（跳过未用到的中间状态）");

  console.log("\n=== 决策 16：部分成功与完全成功区分开 ===");
  const partialJob = await jobs.create({ userId: user.id, jobType: "outfit_preview_generation" });
  await jobs.complete(partialJob.id, { missing: [{ item: "第3套穿搭", reason: "供应商超时" }] });
  const pj = await jobs.get(partialJob.id);
  check(pj?.status === "completed_partial", "有缺失项 → completed_partial（不是 completed）", pj?.status);
  check(Boolean((pj?.partialResult as any)?.missing?.length), "缺失项写进 partialResult 供告知用户");

  const fullJob = await jobs.create({ userId: user.id, jobType: "outfit_preview_generation" });
  await jobs.complete(fullJob.id);
  check((await jobs.get(fullJob.id))?.status === "completed", "无缺失项 → completed");

  const afterTerminal = await jobs.transition(fullJob.id, "rendering");
  check(!afterTerminal.ok, "终态不可再跃迁", afterTerminal.ok ? "" : afterTerminal.reason.slice(0, 50));

  console.log("\n=== 7.3 渐进式部分结果 ===");
  await jobs.mergePartialResult(jobId, { textRecommendations: [{ name: "微碎盖" }] });
  const poll1 = await app.inject({ method: "GET", url: `/analysis-jobs/${jobId}`, headers: { cookie } });
  const p1 = poll1.json();
  check(poll1.statusCode === 200 && p1.terminal === false && Boolean(p1.partialResult?.textRecommendations),
    "非终态就能读到文字推荐（不必等图片）", `status=${p1.status}`);
  await jobs.mergePartialResult(jobId, { hairstylePreviews: [{ nameZh: "微碎盖" }], hairstylePreviewsPending: 2 });
  const p2 = (await app.inject({ method: "GET", url: `/analysis-jobs/${jobId}`, headers: { cookie } })).json();
  check(p2.partialResult.hairstylePreviews.length === 1 && p2.partialResult.hairstylePreviewsPending === 2,
    "图片逐张追加且带剩余待生成数", `已出1张，还剩${p2.partialResult.hairstylePreviewsPending}张`);
  check(Array.isArray(p2.expectedFlow) && p2.expectedFlow.length > 0, "返回完整状态序列供客户端算进度", p2.expectedFlow.join("→"));

  console.log("\n=== 越权访问 ===");
  const other = await app.inject({ method: "POST", url: "/auth/device-session" });
  const otherCookie = `${SESSION_COOKIE_NAME}=${other.json().deviceSessionId}`;
  const forbidden = await app.inject({ method: "GET", url: `/analysis-jobs/${jobId}`, headers: { cookie: otherCookie } });
  check(forbidden.statusCode === 403, "他人 job 返回 403", `HTTP ${forbidden.statusCode}`);

  console.log("\n=== 7.4 两步选择的前置约束 ===");
  const plan = await prisma.appearancePlan.create({ data: { userId: user.id, track: "short_term", generationSeed: 1 } });
  const noHair = await app.inject({ method: "POST", url: `/plans/${plan.id}/outfit-previews`, headers: { cookie } });
  check(noHair.statusCode === 422 && noHair.json().error === "hairstyle_not_selected",
    "未选发型时拒绝生成穿搭预览（穿搭候选集依赖发型，决策 3）");
  await prisma.appearancePlan.update({ where: { id: plan.id }, data: { selectedHairstyleId: "h1" } });
  const withHair = await app.inject({ method: "POST", url: `/plans/${plan.id}/outfit-previews`, headers: { cookie } });
  check(withHair.statusCode === 202, "选定发型后可生成穿搭预览");

  console.log("\n=== 决策 15：容量限流独立于计费 ===");
  let lastCode = 0;
  for (let i = 0; i < 5; i++) {
    const r = await app.inject({ method: "POST", url: `/plans/${plan.id}/target-images/regenerate`, headers: { cookie } });
    lastCode = r.statusCode;
    if (r.statusCode === 429) { console.log(`     第 ${i + 1} 次被限流：${r.json().message}`); break; }
  }
  check(lastCode === 429, "连续生成请求触发每小时容量上限（保护全局串行队列）");

  await prisma.user.deleteMany({ where: { deviceSessionId: { in: [sid, other.json().deviceSessionId] } } });
  console.log(`\n${fail === 0 ? "全部通过" : "有失败项"}：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exit(1);
} finally { await app.close(); }
