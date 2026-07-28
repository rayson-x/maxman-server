import test from "node:test";
import assert from "node:assert/strict";
import { recommendWardrobe } from "./recommend.js";

test("selected styles are retained and every required slot has catalog replacements", () => {
  const result = recommendWardrobe(
    { scene: "通勤", season: "秋", heightCm: 172, weightKg: 78, bodyType: "偏壮" },
    { selectedStyleIds: ["clean-fit", "model-off-duty"], requestedLookCount: 3 },
  );

  assert.deepEqual(result.selectedStyleIds, ["clean-fit", "model-off-duty"]);
  assert.ok(result.looks.some((look) => look.styleId === "clean-fit"));
  assert.ok(result.looks.some((look) => look.styleId === "model-off-duty"));
  assert.equal(result.looks[0]?.role, "primary");
  for (const look of result.looks) for (const slot of look.slots) {
    assert.ok(slot.wardrobeItemId.startsWith("wi-"));
    assert.ok(slot.replacementItemIds.length >= 3);
    assert.match(slot.asset?.localPath ?? "", /^\/wardrobe-items\/v1\/wi-/);
    assert.equal(slot.asset?.canUseForVirtualTryOn, false);
  }
});

test("unknown selected style fails instead of inventing a style", () => {
  assert.throws(
    () => recommendWardrobe({}, { selectedStyleIds: ["not-a-style"] }),
    /系统衣柜中存在/,
  );
});

test("requested count cannot remove an explicitly selected style", () => {
  const result = recommendWardrobe({}, { selectedStyleIds: ["clean-fit", "model-off-duty"], requestedLookCount: 1 });
  assert.equal(result.looks.length, 2);
});

test("supply is opt-in and remains a link-out candidate rather than an owned product image", () => {
  const [look] = recommendWardrobe({}, { selectedStyleIds: ["clean-fit"], includeSupply: true }).looks;
  assert.ok(look?.slots.some((slot) => (slot.supply?.length ?? 0) > 0));
});

test("the same profile and request produce the same JSON-catalog bundle", () => {
  const input = { scene: "通勤", season: "冬" as const, heightCm: 165, weightKg: 95, bodyType: "偏壮" };
  const request = { selectedStyleIds: ["editorial-male-model"], requestedLookCount: 3 };
  assert.deepEqual(recommendWardrobe(input, request), recommendWardrobe(input, request));
});
