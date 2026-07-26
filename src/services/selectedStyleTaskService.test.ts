import assert from "node:assert/strict";
import test from "node:test";

import { buildSelectedStyleTaskSpecs } from "./selectedStyleTaskService.js";

/**
 * 选定项现在来自 `RecommendationCandidate`（可能由 Agent 产出、无目录引用、无审美评分），
 * 所以这里只断言「任务可追溯到选定的方向」这个原意，
 * 不再断言 styleTag 或从双审美评分推出的 dimensions。
 */

test("selected hairstyle and outfit become traceable executable task specs", () => {
  const specs = buildSelectedStyleTaskSpecs({
    hairstyle: { kind: "hairstyle", nameZh: "微碎盖", description: "额前留碎发的短盖头" },
    outfit: { kind: "outfit", nameZh: "素色T恤+直筒裤", description: "纯色上装配直筒下装" },
  });

  assert.equal(specs.length, 2);
  assert.deepEqual(
    specs.map((s) => ({ domain: s.domain, range: s.applicableStageRange, evidence: s.evidenceBasis })),
    [
      { domain: "hairstyle", range: ["stage1"], evidence: "self_reported" },
      { domain: "outfit", range: ["stage1"], evidence: "self_reported" },
    ],
  );

  // 标题与变化描述都带上选定的方向名，账本条目因此可追溯
  assert.match(specs[0]!.title, /微碎盖/);
  assert.match(specs[0]!.changeDescription, /微碎盖/);
  assert.match(specs[1]!.title, /素色T恤\+直筒裤/);

  // 没有经过校准的评分数据，就不给 dimensions——
  // 编一组中性分值把「不可得」洗成「已评估」比让任务排在后面有害得多
  assert.equal(specs[0]!.dimensions, undefined);
  assert.equal(specs[1]!.dimensions, undefined);
});

test("style task construction rejects missing or kind-mismatched selections", () => {
  assert.throws(
    () => buildSelectedStyleTaskSpecs({ hairstyle: null, outfit: { kind: "outfit", nameZh: "x", description: "d" } }),
    /需要同时选定发型与穿搭/,
  );
  assert.throws(
    () => buildSelectedStyleTaskSpecs({ hairstyle: { kind: "outfit", nameZh: "x", description: "d" }, outfit: { kind: "outfit", nameZh: "y", description: "d" } }),
    /类型与方案字段不匹配/,
  );
});
