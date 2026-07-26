import "dotenv/config";
import { submitVolcVisualTask } from "../features/appearance-agent/providers/volcengine/signedRequest.js";

/**
 * 12.4：不同 req_key 是否共享同一并发池？
 *
 * 为什么值得花 2 次调用查清：如果**独立池**，文生图与图生图可以交错调度，
 * 有效并发从 1 变成 2，吞吐直接翻倍；如果**共享池**，那 design.md 决策 12 的
 * 吞吐天花板（46-92 用户/小时）就是硬上限，只能靠接第二家供应商或扩容解决。
 *
 * 方法：**绕过队列限流**（设 VOLC_SKIP_INPROCESS_RATE_LIMIT=1），
 * 同时提交一个文生图和一个图生图。
 *   - 若第二个返回 code 50430 → 共享池
 *   - 若两个都拿到 task_id  → 独立池
 *
 * 只提交不轮询——判断共享与否只需看提交是否被拒，拿到 task_id 即已产生费用，
 * 轮询与否不影响计费，所以不浪费额外时间等结果。
 */

// 绕过进程内限流，否则两个请求会被隔开 600ms，测不出并发冲突
process.env.VOLC_SKIP_INPROCESS_RATE_LIMIT = "1";

const T2I_REQ_KEY = "high_aes_general_v21_L"; // 文生图，本 session 已验证可用
const I2I_REQ_KEY = "seededit_v3.0"; // 图生图，本 session 已验证可用
const TEST_IMAGE = "https://picsum.photos/id/64/512/512.jpg";

type SubmitOutcome =
  | { kind: "ok"; reqKey: string; taskId: string; ms: number }
  | { kind: "rejected"; reqKey: string; code: number; message: string; ms: number }
  | { kind: "error"; reqKey: string; error: string; ms: number };

async function submit(reqKey: string, body: Record<string, unknown>, label: string): Promise<SubmitOutcome> {
  const t0 = Date.now();
  try {
    const r = await submitVolcVisualTask(reqKey, body, { purpose: `pool-probe-${label}` });
    const ms = Date.now() - t0;
    if (r.data?.task_id) return { kind: "ok", reqKey, taskId: r.data.task_id, ms };
    return { kind: "rejected", reqKey, code: r.code, message: r.message ?? JSON.stringify(r), ms };
  } catch (err) {
    const ms = Date.now() - t0;
    const msg = err instanceof Error ? err.message : String(err);
    // 50430 会以 HTTP 429 抛出，从错误文本里提取
    const m = msg.match(/"code":\s*(\d+)/);
    if (m) return { kind: "rejected", reqKey, code: Number(m[1]), message: msg.slice(0, 160), ms };
    return { kind: "error", reqKey, error: msg.slice(0, 160), ms };
  }
}

console.log("同时提交 文生图 + 图生图（已绕过进程内限流），观察是否触发并发冲突…\n");

const [t2i, i2i] = await Promise.all([
  submit(T2I_REQ_KEY, { prompt: "一位中国男性的证件照风格照片，短发，白色背景", width: 512, height: 512 }, "t2i"),
  submit(I2I_REQ_KEY, { image_urls: [TEST_IMAGE], prompt: "把头发改成寸头", negative_prompt: "", seed: -1, scale: 0.5, return_url: true }, "i2i"),
]);

for (const r of [t2i, i2i]) {
  const tag = r.reqKey === T2I_REQ_KEY ? "文生图" : "图生图";
  if (r.kind === "ok") console.log(`  ${tag} (${r.reqKey})  ✅ 提交成功  task_id=${r.taskId}  ${r.ms}ms`);
  else if (r.kind === "rejected") console.log(`  ${tag} (${r.reqKey})  ⛔ 被拒 code=${r.code}  ${r.ms}ms\n     ${r.message}`);
  else console.log(`  ${tag} (${r.reqKey})  ❗ 异常  ${r.error}`);
}

const rejectedForConcurrency = [t2i, i2i].filter((r) => r.kind === "rejected" && r.code === 50430);
const bothOk = t2i.kind === "ok" && i2i.kind === "ok";

console.log("\n──── 结论 ────");
if (bothOk) {
  console.log("✅ 不同 req_key 使用**独立并发池**");
  console.log("   → 文生图与图生图可交错调度，有效并发从 1 提升到 2");
  console.log("   → 可考虑把「示意图生成(文生图)」与「本人效果图(图生图)」放入不同队列并行");
} else if (rejectedForConcurrency.length > 0) {
  console.log("❌ 不同 req_key **共享同一并发池**（出现 code 50430）");
  console.log("   → design.md 决策 12 的吞吐天花板是硬上限，交错调度无效");
  console.log("   → 缓解只能靠：接第二家供应商（StepFun 已备好代码）或付费扩容");
} else {
  console.log("⚠️  未能判定——两个请求都没成功，但也不是并发限制导致：");
  for (const r of [t2i, i2i]) {
    if (r.kind === "rejected") console.log(`   ${r.reqKey}: code=${r.code}`);
    if (r.kind === "error") console.log(`   ${r.reqKey}: ${r.error}`);
  }
  console.log("   需排除凭证/参数问题后重测");
}

const billed = [t2i, i2i].filter((r) => r.kind === "ok").length;
console.log(`\n本次实际产生费用的调用：${billed} 次（约 ¥${(billed * 0.2).toFixed(1)}）`);
