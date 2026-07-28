import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reviewFreeInput } from "./domainLexicon.js";

/**
 * 词库是子串匹配，所以**短词的误杀风险很高**，而误杀的代价不是"少一个候选"：
 * `validateCandidates` 命中即整条丢弃，一批候选可能全灭 → 用户拿到空清单、
 * 既没有效果图也走不到穿搭选择。实测踩过：
 *   - 裸的 "整成" 命中「两侧修**整成**渐层」→ 判为冒充明星
 *   - 裸的 "填充" 命中「视觉**填充**发量」→ 判为医美
 * 三个发型候选因此全被拒，job 收成 completed_partial。
 *
 * 所以这里两个方向都要锁：正当文案必须放行，红线必须拦住。
 */
describe("domainLexicon", () => {
  it("放行正当的发型与穿搭文案（防子串误杀）", () => {
    const legit = [
      "两侧修整成自然渐层，顶部保留层次",
      "把鬓角修整成干净的线条",
      "通过蓬松感视觉填充发量，让顶部更饱满",
      "额前留碎发盖住发际线，两侧收干净",
      "适合发量偏少的用户，避免头顶塌陷",
      "整齐的侧分，展现成熟稳重",
      "通过发型显小脸",
      "显高的穿搭比例",
    ];
    for (const text of legit) {
      assert.notEqual(
        reviewFreeInput(text).kind,
        "blocked",
        `正当文案被误杀：「${text}」`,
      );
    }
  });

  it("拦住无歧义的越界请求", () => {
    const cases: [string, string][] = [
      ["我想整成明星那样的脸", "impersonation"],
      ["照着他整一个一样的", "impersonation"],
      ["给我做面部填充", "facial_structure"],
      ["打玻尿酸填充下巴", "facial_structure"],
      ["削骨磨骨改脸型", "facial_structure"],
      ["把下巴削尖一点", "facial_structure"],
      ["把我变成女生", "identity_attribute"],
      ["帮我加点腹肌", "body_enhancement"],
    ];
    for (const [text, category] of cases) {
      const verdict = reviewFreeInput(text);
      assert.equal(verdict.kind, "blocked", `红线漏放：「${text}」`);
      if (verdict.kind === "blocked") {
        assert.equal(verdict.category, category, `分类不符：「${text}」`);
      }
    }
  });
});
