import assert from "node:assert/strict";
import test from "node:test";

import { basicQuestionnaireSchema, faceMetricsSchema } from "./intake.js";

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

test("face metrics accept the new bounded style signals and strip unknown fields", () => {
  const parsed = faceMetricsSchema.parse({
    classification: {
      visualYouthfulness: { value: "high" },
      facialGenderTendency: { value: "masculine" },
      cheekboneCoverageNeed: { value: "medium" },
    },
    untrustedExtra: "must not cross the API boundary",
  });

  assert.deepEqual(parsed, {
    classification: {
      visualYouthfulness: { value: "high" },
      facialGenderTendency: { value: "masculine" },
      cheekboneCoverageNeed: { value: "medium" },
    },
  });
});

test("face metrics reject unsupported values for new style signals", () => {
  const result = faceMetricsSchema.safeParse({
    classification: {
      visualYouthfulness: { value: "ageless" },
      facialGenderTendency: { value: "unknown" },
      cheekboneCoverageNeed: { value: "always" },
    },
  });

  assert.equal(result.success, false);
});
