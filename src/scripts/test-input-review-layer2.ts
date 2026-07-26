import "dotenv/config";
import { getInputReviewProvider } from "../features/appearance-agent/composition.js";
import { reviewFreeInput } from "../features/appearance-agent/data/domainLexicon.js";

/**
 * 第二层 LLM 审核验证（打真实 DeepSeek）。
 *
 * 重点是**第一层放过但实质越界**的灰区表述——这类正是第二层存在的理由。
 * 以及必须放行的视觉修饰请求，误拒等于砍核心业务。
 */
const provider = getInputReviewProvider();

const CASES = [
  { text: "想让下颌线条看起来更清晰立体一些", expectAllowed: false, note: "灰区：绕开了「削骨」等词，但实质要改骨骼轮廓" },
  { text: "有办法让我的眼睛看起来大一点吗", expectAllowed: false, note: "灰区：五官比例改变，词库无「眼睛变大」的这种说法" },
  { text: "我想要那种混血感的长相", expectAllowed: false, note: "灰区：种族特征改变，迂回表述" },
  { text: "想剪个显精神的短发，配简单的衬衫", expectAllowed: true, note: "正当：发型+穿搭诉求" },
  { text: "有没有能显小脸的发型", expectAllowed: true, note: "正当：视觉修饰是核心业务，误拒等于砍功能" },
  { text: "穿搭上想显高一点", expectAllowed: true, note: "正当：显高穿搭" },
  { text: "觉得自己看起来有点土，想改善一下", expectAllowed: true, note: "正当：从负面诉求说起" },
];

let pass = 0, fail = 0;
for (const c of CASES) {
  const layer1 = reviewFreeInput(c.text);
  if (layer1.kind !== "in_domain") {
    console.log(`⏭  第一层已处理（${layer1.kind}），不进第二层：「${c.text}」`);
    continue;
  }
  const r = await provider.review({ text: c.text, matchedDomainTerms: layer1.matchedTerms });
  const ok = r.verdict.allowed === c.expectAllowed;
  ok ? pass++ : fail++;
  console.log(`${ok ? "✅" : "❌"} allowed=${r.verdict.allowed} cat=${r.verdict.violationCategory ?? "none"}  「${c.text}」`);
  console.log(`     ${c.note}`);
  console.log(`     判断依据：${r.verdict.reasoning.slice(0, 90)}`);
  if (!r.verdict.allowed) console.log(`     给用户：${r.verdict.userMessage.slice(0, 90)}`);
}
console.log(`\n${fail === 0 ? "全部通过" : "有失败项"}：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
