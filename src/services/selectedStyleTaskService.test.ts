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

test("an uncalibrated hairstyle remains actionable but is never sent to the image generator", () => {
  const [hairstyle] = buildSelectedStyleTaskSpecs({
    hairstyle: { kind: "hairstyle", nameZh: "未校准实验发型", description: "用户想尝试的方向" },
    outfit: { kind: "outfit", nameZh: "素色T恤+直筒裤", description: "纯色上装配直筒下装" },
  });

  assert.equal(hairstyle?.renderDescription, undefined);
  assert.match(hairstyle?.changeDescription ?? "", /未校准实验发型/);
});

/*
 * 达成路径（WIG-004 遗留项）。一个只有戴假发才能达成的发型，落进变更清单时必须写明
 * 这一点——否则用户会以为剪个头发就能变成效果图里的样子。
 */

test("a wig-achieved hairstyle carries its achievement path into the change list", () => {
  const specs = buildSelectedStyleTaskSpecs({
    hairstyle: {
      kind: "hairstyle",
      nameZh: "大背头",
      description: "往后梳的光滑造型",
      achievement: { label: "这个款式会露出发际线，需要整顶假发才能做到" },
    },
    outfit: { kind: "outfit", nameZh: "素色T恤+直筒裤", description: "纯色上装配直筒下装" },
  });

  const hairstyle = specs[0]!;
  assert.match(hairstyle.changeDescription, /整顶假发/);
  assert.match(hairstyle.rationale ?? "", /整顶假发/);
});

test("the achievement path never leaks into the image instruction", () => {
  // 发型渲染文案是按图像供应商逐款校准的；混入未校准语义会产出网底、发根断层这类伪影，
  // 而且按仓库规则改指令模板要整套重测。图该画的是「戴上之后长什么样」。
  const specs = buildSelectedStyleTaskSpecs({
    hairstyle: {
      kind: "hairstyle",
      nameZh: "大背头",
      description: "往后梳的光滑造型",
      achievement: { label: "这个款式会露出发际线，需要整顶假发才能做到" },
    },
    outfit: { kind: "outfit", nameZh: "素色T恤+直筒裤", description: "纯色上装配直筒下装" },
  });

  const render = specs[0]!.renderDescription ?? "";
  assert.ok(render.length > 0, "大背头在属性表内，应有校准过的渲染文案");
  assert.doesNotMatch(render, /假发|发片/);
});

test("a hairstyle with no wig involvement is described exactly as before", () => {
  const withoutWig = buildSelectedStyleTaskSpecs({
    hairstyle: { kind: "hairstyle", nameZh: "微碎盖", description: "额前留碎发的短盖头" },
    outfit: { kind: "outfit", nameZh: "素色T恤+直筒裤", description: "纯色上装配直筒下装" },
  });
  assert.doesNotMatch(withoutWig[0]!.changeDescription, /假发|发片/);
  assert.doesNotMatch(withoutWig[0]!.rationale ?? "", /假发|发片/);
});

test("a wig-set hairstyle is accepted by materialisation, not rejected as a type mismatch", () => {
  // 假发款落在独立集合（kind: hairstyle_wig）里。漏掉它会让选了假发款的用户在方案落地时抛错。
  const specs = buildSelectedStyleTaskSpecs({
    hairstyle: {
      kind: "hairstyle_wig",
      nameZh: "大背头",
      description: "往后梳的光滑造型",
      achievement: { label: "这个款式会露出发际线，需要整顶假发才能做到" },
    },
    outfit: { kind: "outfit", nameZh: "素色T恤+直筒裤", description: "纯色上装配直筒下装" },
  });

  assert.equal(specs.length, 2);
  assert.equal(specs[0]!.domain, "hairstyle");
  assert.match(specs[0]!.changeDescription, /整顶假发/);
});
