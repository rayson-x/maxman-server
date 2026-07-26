import "dotenv/config";
import { createContainer } from "../app/container.js";
import { buildApp } from "../app/server.js";
import { SESSION_COOKIE_NAME } from "../services/sessionService.js";

/**
 * 两层审核的端到端验证，重点是修复后的**灰区路径**：
 * 越界但用视觉修饰措辞、且不含造型词汇的输入，必须由第二层拦住并给出
 * 边界说明，而不是被第一层判为 out_of_domain 回一句"没太理解"。
 */
const container = createContainer({ withQueues: false });
const app = await buildApp({ container, logger: false });
let pass = 0, fail = 0;
const check = (ok: boolean, label: string, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "✅" : "❌"} ${label}${detail ? `  ${detail}` : ""}`); };

try {
  const s = await app.inject({ method: "POST", url: "/auth/device-session" });
  const cookie = `${SESSION_COOKIE_NAME}=${s.json().deviceSessionId}`;
  const ask = (t: string) => app.inject({ method: "POST", url: "/intake/hair-intent", headers: { cookie }, payload: { hasPreference: true, preferenceText: t } });

  console.log("=== 第一层红线（应终止，不进第二层）===");
  const r1 = await ask("把我的下巴削尖一点");
  check(r1.statusCode === 422 && r1.json().reason === "blocked" && r1.json().category === "facial_structure",
    "无歧义越界被第一层终止", `layer1 category=${r1.json().category}`);

  console.log("\n=== 灰区：越界但用视觉措辞 + 无造型词汇（修复的重点）===");
  // 注意「想让下颌线条看起来更清晰立体」不在此列——复核后认为它应当**放行**：
  // 修胡形、调发量平衡确实能让下颌线条视觉上更清晰，这是理发师日常在做的事。
  // 它归一化不到目录 tag，会走「用户指定方向、不背书」路径，正是为这种情况设计的处理。
  for (const t of ["有办法让我的眼睛看起来大一点吗", "我想要那种混血感的长相"]) {
    const r = await ask(t);
    const j = r.json();
    const blockedByL2 = r.statusCode === 422 && j.layer === 2 && j.reason === "blocked_by_review";
    check(blockedByL2, `「${t}」被第二层拦住并给边界说明`, `cat=${j.category ?? "-"} reason=${j.reason}`);
    if (blockedByL2) console.log(`     给用户：${String(j.message).slice(0, 80)}`);
  }

  console.log("\n=== 正当请求（必须放行，误拒等于砍功能）===");
  for (const t of ["有没有能显小脸的发型", "穿搭上想显高一点", "想剪个显精神的短发", "想让下颌线条看起来更清晰立体一些"]) {
    const r = await ask(t);
    const j = r.json();
    check(r.statusCode === 200 && j.accepted === true, `「${t}」放行`, `layer1=${j.layer1Kind} 第二层已审=${j.secondLayerReviewed}`);
  }

  console.log("\n=== 真正无关的输入（第二层判 out_of_scope）===");
  const oob = await ask("帮我写一段 Python 代码");
  const oj = oob.json();
  check(oob.statusCode === 422 && oj.reason === "out_of_domain", "无关输入被拒", `layer=${oj.layer ?? 1} cat=${oj.category ?? "-"}`);

  await container.prisma.user.deleteMany({ where: { deviceSessionId: s.json().deviceSessionId } });
  console.log(`\n${fail === 0 ? "全部通过" : "有失败项"}：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exit(1);
} finally { await app.close(); }
