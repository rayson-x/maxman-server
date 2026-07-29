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
      cheekboneCoverageNeed: { value: "medium" },
    },
    untrustedExtra: "must not cross the API boundary",
  });

  assert.deepEqual(parsed, {
    classification: {
      visualYouthfulness: { value: "high" },
      cheekboneCoverageNeed: { value: "medium" },
    },
  });
});

test("face metrics reject unsupported values for new style signals", () => {
  const result = faceMetricsSchema.safeParse({
    classification: {
      visualYouthfulness: { value: "ageless" },
      cheekboneCoverageNeed: { value: "always" },
    },
  });

  assert.equal(result.success, false);
});

test("face metrics accept a bounded portrait profile but reject landmark-shaped input", () => {
  const accepted = faceMetricsSchema.safeParse({
    classification: { faceShape: { value: "oval" } },
    portraitProfile: {
      version: 1,
      measuredAt: "2026-07-28T00:00:00.000Z",
      capture: { qualityPassed: true, frameCount: 8, stability: "high", evidence: { maxPoseMagnitude: 2 } },
      signals: {
        lengthWidthRatio: {
          value: 1.42,
          source: "client_measurement",
          confidence: "medium",
          stability: "high",
          evidence: { frameCount: 8 },
        },
      },
    },
  });
  assert.equal(accepted.success, true);

  const rejected = faceMetricsSchema.safeParse({
    classification: {},
    portraitProfile: {
      version: 1,
      measuredAt: "2026-07-28T00:00:00.000Z",
      capture: { qualityPassed: true, frameCount: 8, stability: "high", evidence: {} },
      signals: { lengthWidthRatio: { value: 1.42, landmark: [0.1, 0.2] } },
    },
  });
  assert.equal(rejected.success, false);
});
