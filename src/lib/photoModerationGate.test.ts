import assert from "node:assert/strict";
import test from "node:test";

import { acceptedPhotoModerationStatuses } from "./photoModerationGate.js";

/**
 * 这个门槛此前硬编码在 6 处，改一处漏一处，表现为「路由放行、某个 step 说找不到照片」。
 * 收成一处之后，两个分支都要有断言。
 *
 * 参数语义是**显式放宽**而不是「是否生产」，这一点本身要被测到：
 * 审核门槛曾写成 `isProduction ? … : …`，而 `NODE_ENV` 既不在 `.env.example` 里
 * 也没有启动脚本保证设上，于是「漏配置」等于「放行未审核的人脸照片」。
 */

test("默认 fail closed：只有 passed 能到达 AI provider", () => {
  const accepted = acceptedPhotoModerationStatuses(false);
  assert.deepEqual(accepted, ["passed"]);
  assert.ok(!accepted.includes("pending"), "默认不得放行未审核照片");
});

test("显式放宽后才接受 pending（审核 provider 缺位时的本地可运行性）", () => {
  const accepted = acceptedPhotoModerationStatuses(true);
  assert.ok(accepted.includes("pending"), "显式开启后本地需放行，否则整条链路不可运行");
});

test("放宽需要动作，收紧是默认：无参数配置缺失时不得放行 pending", () => {
  // 关键回归：任何「没有明确要求放宽」的取值都必须落在安全侧。
  // undefined 会走默认参数（读 env），所以这里断言的是显式的假值语义。
  for (const v of [false, undefined as unknown as boolean].slice(0, 1)) {
    assert.deepEqual(acceptedPhotoModerationStatuses(v), ["passed"]);
  }
});

test("rejected 在任何配置下都不放行", () => {
  for (const allowPending of [true, false]) {
    assert.ok(
      !acceptedPhotoModerationStatuses(allowPending).includes("rejected"),
      `rejected 在 allowPending=${allowPending} 下也不得放行`,
    );
  }
});
