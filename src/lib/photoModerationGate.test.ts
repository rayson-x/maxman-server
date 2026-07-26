import assert from "node:assert/strict";
import test from "node:test";

import { acceptedPhotoModerationStatuses } from "./photoModerationGate.js";

/**
 * 这个门槛此前硬编码在 6 处，改一处漏一处，表现为「路由放行、某个 step 说找不到照片」。
 * 收成一处之后，两个环境分支都要有断言。
 */

test("production fails closed: only passed photos may reach AI providers", () => {
  const accepted = acceptedPhotoModerationStatuses(true);
  assert.deepEqual(accepted, ["passed"]);
  assert.ok(!accepted.includes("pending"), "生产环境不得放行未审核照片");
});

test("local accepts pending because the moderation provider is deferred", () => {
  const accepted = acceptedPhotoModerationStatuses(false);
  assert.ok(accepted.includes("pending"), "审核 provider 缺位时本地需放行，否则整条链路不可运行");
});

test("rejected is never accepted in any environment", () => {
  for (const isProduction of [true, false]) {
    assert.ok(
      !acceptedPhotoModerationStatuses(isProduction).includes("rejected"),
      `rejected 在 isProduction=${isProduction} 下也不得放行`,
    );
  }
});
