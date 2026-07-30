import assert from "node:assert/strict";
import test from "node:test";

import { wigRenderInstruction } from "./recommendationApplication.js";

/*
 * 假发候选的自由文本字段装的是**达成路径文案**（「需要整顶假发才能做到」）。它绝不能流进
 * 图生图指令：一是把未校准语义塞进按 provider 逐款校准过的模板，二是让「假发」二字进入
 * 图像指令 —— 而图该画的是戴上之后的样子。
 */

test("a style outside the calibrated table gets no render instruction at all", () => {
  // 运行时目录里绝大多数款式没有校准过的渲染描述。空指令 = 不进批量出图，但仍可被选中。
  const instruction = wigRenderInstruction("美式前刺", () => "不应该被调用");
  assert.equal(instruction, "");
});

test("a calibrated style does get one", () => {
  const instruction = wigRenderInstruction("大背头", (c) => `built:${c.nameZh}`);
  assert.equal(instruction, "built:大背头");
});

test("the achievement wording can never reach the instruction", () => {
  // 就算调用方把达成路径文案交给构建函数，未校准的款式也拿不到指令。
  for (const name of ["美式前刺", "短狼尾", "港风中长纹理"]) {
    const instruction = wigRenderInstruction(name, () => "这个款式会露出发际线，需要整顶假发");
    assert.doesNotMatch(instruction, /假发|发片/);
  }
});
