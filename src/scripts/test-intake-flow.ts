import "dotenv/config";
import { createContainer } from "../app/container.js";
import { buildApp } from "../app/server.js";
import { SESSION_COOKIE_NAME } from "../services/sessionService.js";

/**
 * 第 3 节采集链路端到端验证（用 app.inject，不起真实端口）。
 * 重点验的不是"能返回 200"，而是几条设计约束真的成立：
 *   - 会话签发幂等（重复调用不造出第二个 User）
 *   - 无 session 时受保护路由拒绝，而不是隐式建号
 *   - 结构性矛盾被检出但不阻断保存
 *   - 脸型确认以用户修正值覆盖计算值
 *   - 发型意向的红线阻断/脱离范畴/正常通过三条路径
 */
const container = createContainer({ withProviders: false });
const app = await buildApp({ container, logger: false });

let pass = 0;
let fail = 0;
const check = (ok: boolean, label: string, detail = "") => {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? `  ${detail}` : ""}`);
};

try {
  // --- 会话 ---
  const noSession = await app.inject({ method: "POST", url: "/questionnaire/basic", payload: { track: "short_term", ageConfirmed18Plus: true } });
  check(noSession.statusCode === 401, "无 session 访问受保护路由被拒（不隐式建号）", `HTTP ${noSession.statusCode}`);

  const s1 = await app.inject({ method: "POST", url: "/auth/device-session" });
  const sessionId = s1.json().deviceSessionId as string;
  check(s1.statusCode === 201 && Boolean(sessionId), "首次签发匿名会话", `HTTP ${s1.statusCode}`);

  const cookie = `${SESSION_COOKIE_NAME}=${sessionId}`;
  const s2 = await app.inject({ method: "POST", url: "/auth/device-session", headers: { cookie } });
  check(s2.statusCode === 200 && s2.json().reused === true && s2.json().deviceSessionId === sessionId, "重复调用幂等（复用而非新建）");

  const userCount = await container.prisma.user.count({ where: { deviceSessionId: sessionId } });
  check(userCount === 1, "库中只有一条 User（幂等的实质验证）", `count=${userCount}`);

  // --- 问卷 ---
  const basic = await app.inject({ method: "POST", url: "/questionnaire/basic", headers: { cookie }, payload: { track: "short_term", ageConfirmed18Plus: true } });
  check(basic.statusCode === 200, "基础问卷提交", `HTTP ${basic.statusCode}`);

  const badFull = await app.inject({ method: "POST", url: "/questionnaire/full", headers: { cookie }, payload: { domainSelections: ["hair"] } });
  check(badFull.statusCode === 400 && badFull.json().error === "validation_failed", "缺 budgetTier 被 zod 拦为 400（不漏成 500）", `HTTP ${badFull.statusCode}`);

  const contradictory = await app.inject({
    method: "POST", url: "/questionnaire/full", headers: { cookie },
    payload: { heightCm: 175, weightKg: 68, bodyFatPercent: 5, exercisesRegularly: false, selfReportedHairVolume: "thick", hairLossConcern: true, domainSelections: ["hair", "outfit"], budgetTier: "low" },
  });
  const issues = contradictory.json().contradictions as { field: string }[];
  check(contradictory.statusCode === 200 && issues.length >= 2, "结构性矛盾被检出但不阻断保存", `检出 ${issues.length} 项: ${issues.map((i) => i.field).join(", ")}`);

  const saved = await container.prisma.appearanceProfile.findUnique({ where: { userId: s1.json().deviceSessionId ? (await container.prisma.user.findUnique({ where: { deviceSessionId: sessionId } }))!.id : "" } });
  check(saved?.hairLossConcern === true && saved?.selfReportedHairVolume === "thick", "自报发量与脱发困扰已落库（决策 6 的交叉验证输入）");

  // --- 同意 ---
  const consent = await app.inject({ method: "POST", url: "/photos/consent", headers: { cookie }, payload: { consentType: "face_processing", version: "v1.0" } });
  check(consent.statusCode === 201, "人脸处理同意版本化存证", `HTTP ${consent.statusCode}`);

  // --- 照片 + faceMetrics ---
  const reg = await app.inject({
    method: "POST", url: "/photos", headers: { cookie },
    payload: {
      photoType: "front", storageKey: "raw/test/front.jpg",
      faceMetrics: { schemaVersion: 1, classification: { faceShape: { value: "oblong", confidence: "high", evidence: { lengthWidthRatio: 1.32 } } } },
    },
  });
  check(reg.statusCode === 201, "照片登记 + faceMetrics 落库", `HTTP ${reg.statusCode}`);

  const computed = await app.inject({ method: "GET", url: "/face-shape/computed", headers: { cookie } });
  const cj = computed.json();
  check(computed.statusCode === 200 && cj.faceShape === "oblong" && cj.evidence?.lengthWidthRatio === 1.32,
    "脸型来自客户端测量且带支撑比值（决策 5）", `${cj.faceShape} conf=${cj.confidence} ratio=${cj.evidence?.lengthWidthRatio}`);

  const confirm = await app.inject({ method: "POST", url: "/face-shape/confirm", headers: { cookie }, payload: { confirmedFaceShape: "square" } });
  const profile = await container.prisma.appearanceProfile.findFirst({ where: { user: { deviceSessionId: sessionId } } });
  check(confirm.statusCode === 200 && profile?.confirmedFaceShape === "square", "用户修正值覆盖计算值（决策 5）", `computed=oblong → confirmed=${profile?.confirmedFaceShape}`);

  // --- 发型意向三条路径 ---
  const noPref = await app.inject({ method: "POST", url: "/intake/hair-intent", headers: { cookie }, payload: { hasPreference: false } });
  check(noPref.statusCode === 200 && noPref.json().next === "recommendation_only", "无意向 → 直接走推荐（不产生该分支开销）");

  const blocked = await app.inject({ method: "POST", url: "/intake/hair-intent", headers: { cookie }, payload: { hasPreference: true, preferenceText: "想要碎盖，另外把下巴削尖一点" } });
  const bj = blocked.json();
  check(blocked.statusCode === 422 && bj.category === "facial_structure", "红线阻断（既在范畴内也命中红线 → 红线优先）", bj.category);

  const oob = await app.inject({ method: "POST", url: "/intake/hair-intent", headers: { cookie }, payload: { hasPreference: true, preferenceText: "帮我写一段代码" } });
  check(oob.statusCode === 422 && oob.json().reason === "out_of_domain", "脱离范畴被拒");

  const inCatalog = await app.inject({ method: "POST", url: "/intake/hair-intent", headers: { cookie }, payload: { hasPreference: true, preferenceText: "我想试试碎盖那种发型" } });
  const icj = inCatalog.json();
  check(inCatalog.statusCode === 200 && icj.normalizedStyleTag === "微碎盖" && icj.labelAsUserSpecified === false,
    "命中目录 tag → 用审核文案，不标注为用户指定", `tag=${icj.normalizedStyleTag}`);

  const outCatalog = await app.inject({ method: "POST", url: "/intake/hair-intent", headers: { cookie }, payload: { hasPreference: true, preferenceText: "想要韩系锁骨微卷的发型" } });
  const ocj = outCatalog.json();
  check(outCatalog.statusCode === 200 && ocj.normalizedStyleTag === null && ocj.labelAsUserSpecified === true,
    "未命中目录但过审 → 标注为「你指定的方向」（决策 9 的责任边界）");

  const badGate = await app.inject({ method: "POST", url: "/intake/hair-intent", headers: { cookie }, payload: { hasPreference: true } });
  check(badGate.statusCode === 400, "hasPreference=true 但没给文本 → 400", `HTTP ${badGate.statusCode}`);

  // 清理
  await container.prisma.user.deleteMany({ where: { deviceSessionId: sessionId } });

  console.log(`\n${fail === 0 ? "全部通过" : "有失败项"}：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exit(1);
} finally {
  await app.close();
}
