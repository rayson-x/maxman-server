import assert from "node:assert/strict";
import test from "node:test";

import { basicQuestionnaireSchema } from "./intake.js";

test("basic questionnaire accepts a bounded province/city pair", () => {
  const parsed = basicQuestionnaireSchema.parse({
    track: "long_term",
    ageConfirmed18Plus: true,
    province: "浙江省",
    city: "杭州市",
  });

  assert.equal(parsed.province, "浙江省");
  assert.equal(parsed.city, "杭州市");
});

test("basic questionnaire rejects a partial location pair", () => {
  const result = basicQuestionnaireSchema.safeParse({
    track: "short_term",
    ageConfirmed18Plus: true,
    city: "杭州市",
  });

  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(
      result.error.issues.some((issue) => issue.path[0] === "province"),
      true,
    );
  }
});
