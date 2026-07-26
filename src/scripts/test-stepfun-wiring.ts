import "dotenv/config";
import { resetProviderRegistry, getImageEditProvider } from "../features/appearance-agent/composition.js";
import { STEPFUN_CLAIMED_SPECS } from "../features/appearance-agent/providers/imageEdit/stepfunImageEdit.js";
import { env } from "../config/env.js";

/**
 * 12.1 装配验证。不打真实 API（无凭证），验的是：
 *   - 能通过 ACTIVE_IMAGE_EDIT_PROVIDER 切到 stepfun
 *   - 缺 key 时**构造即抛错**，不静默产出一个永远失败的 provider
 *   - 默认仍是 volcengine（不因为新增选项而改变默认行为）
 */
let pass = 0, fail = 0;
const check = (ok: boolean, label: string, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "✅" : "❌"} ${label}${detail ? `  ${detail}` : ""}`); };

console.log(`StepFun 公开参数（未实测）：${STEPFUN_CLAIMED_SPECS.latencySeconds}s / ¥${STEPFUN_CLAIMED_SPECS.pricePerImageCNY}/张，同步API=${STEPFUN_CLAIMED_SPECS.syncApi}`);
console.log(`对比火山实测：13s / ¥0.2/张，异步 submit+poll，并发上限 1\n`);

resetProviderRegistry();
delete process.env.ACTIVE_IMAGE_EDIT_PROVIDER;
const def = getImageEditProvider();
check(def.name.includes("volcengine"), "默认仍是 volcengine（新增选项不改变默认行为）", def.name);

resetProviderRegistry();
process.env.ACTIVE_IMAGE_EDIT_PROVIDER = "stepfun";
const hasKey = Boolean(env.stepfun.apiKey);
if (hasKey) {
  const p = getImageEditProvider();
  check(p.name === "stepfun-image-edit-2", "已配置 key → 成功切到 stepfun", p.name);
  console.log("   （检测到 STEPFUN_API_KEY，可以跑真实调用验证了）");
} else {
  let threw = false, msg = "";
  try { getImageEditProvider(); } catch (e) { threw = true; msg = e instanceof Error ? e.message : String(e); }
  check(threw && msg.includes("STEPFUN_API_KEY"), "缺 key 时构造即抛错并指明缺哪个变量（不静默降级）", msg);
}

resetProviderRegistry();
process.env.ACTIVE_IMAGE_EDIT_PROVIDER = "nonexistent";
let threw2 = false, msg2 = "";
try { getImageEditProvider(); } catch (e) { threw2 = true; msg2 = e instanceof Error ? e.message : String(e); }
check(threw2 && msg2.includes("stepfun"), "未知 provider 名报错并列出可选项（含 stepfun）", msg2);

resetProviderRegistry();
delete process.env.ACTIVE_IMAGE_EDIT_PROVIDER;
console.log(`\n${fail === 0 ? "全部通过" : "有失败项"}：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
