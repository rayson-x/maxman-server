import { reviewFreeInput, normalizeToStyleTag, BLOCKED_MESSAGES } from "../features/appearance-agent/data/domainLexicon.js";

/** 第一层词库审核的行为验证。纯确定性逻辑，无网络调用。 */
const CASES: { input: string; expect: string; note: string }[] = [
  // 正常范畴内
  { input: "我想试试碎盖那种发型", expect: "in_domain", note: "命中发型词 + 可归一化" },
  { input: "想要清爽干净的日系穿搭", expect: "in_domain", note: "命中穿搭风格词" },
  { input: "约会的时候穿什么衬衫比较好", expect: "in_domain", note: "场景词 + 品类词" },
  { input: "头发想染成浅棕色", expect: "in_domain", note: "发色类" },

  // 红线：改变骨骼/五官
  { input: "把我的下巴削尖一点", expect: "blocked", note: "facial_structure" },
  { input: "想要碎盖，另外把鼻子变高一些", expect: "blocked", note: "红线优先于领域命中" },
  { input: "帮我改一下脸型", expect: "blocked", note: "改脸型" },

  // 红线：身份属性
  { input: "我想看看自己变成女生的样子", expect: "blocked", note: "identity_attribute" },
  { input: "让我看起来变年轻十岁", expect: "blocked", note: "年龄" },

  // 红线：冒充真人
  { input: "我想整成某个明星那样", expect: "blocked", note: "impersonation" },

  // 红线：身体增强
  { input: "给我加上腹肌", expect: "blocked", note: "body_enhancement" },
  { input: "想做断骨增高", expect: "blocked", note: "增高手术" },

  // 必须放过的正当视觉修饰请求（误杀这些等于砍掉核心业务）
  { input: "想让自己看起来更高一点", expect: "in_domain", note: "显高穿搭是正当业务，不可误杀" },
  { input: "有没有显小脸的发型", expect: "in_domain", note: "发型修饰脸型是核心业务" },
  { input: "我的脸型适合什么发型", expect: "in_domain", note: "提到脸型但无改造意图" },
  { input: "想改一下发型", expect: "in_domain", note: "改+发型，发型非敏感部位" },

  // 脱离范畴
  { input: "帮我写一段代码", expect: "out_of_domain", note: "完全无关" },
  { input: "今天天气怎么样", expect: "out_of_domain", note: "闲聊" },
];

let pass = 0;
for (const c of CASES) {
  const v = reviewFreeInput(c.input);
  const ok = v.kind === c.expect;
  if (ok) pass += 1;
  const detail =
    v.kind === "blocked"
      ? `blocked/${v.category} ← ${v.matchedTerms.join(",")}`
      : v.kind === "in_domain"
        ? `in_domain ← ${v.matchedTerms.slice(0, 3).join(",")}`
        : "out_of_domain";
  console.log(`${ok ? "✅" : "❌"} [${c.expect.padEnd(13)}] ${detail.padEnd(46)} "${c.input}"  (${c.note})`);
}

console.log(`\n第一层审核：${pass}/${CASES.length} 通过`);

console.log("\n--- style_tag 归一化 ---");
for (const s of ["我想试试碎盖", "剪个板寸吧", "想弄个油头", "韩系锁骨微卷", "纹理烫"]) {
  const tag = normalizeToStyleTag(s);
  console.log(`  "${s}" → ${tag ?? "(未命中，走「用户指定方向」路径)"}`);
}

console.log("\n--- 红线阻断文案示例 ---");
console.log(`  facial_structure: ${BLOCKED_MESSAGES.facial_structure}`);
