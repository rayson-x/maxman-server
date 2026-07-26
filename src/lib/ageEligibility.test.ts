import assert from "node:assert/strict";
import test from "node:test";
import { isAtLeast18 } from "./ageEligibility.js";
import { basicQuestionnaireSchema } from "../schemas/intake.js";

test("adult eligibility uses a date-only birthday in the explicit policy timezone", () => {
  const birthDate = new Date("2008-07-27T00:00:00.000Z");
  assert.equal(
    isAtLeast18(
      birthDate,
      new Date("2026-07-26T15:59:59.000Z"),
      "Asia/Shanghai",
    ),
    false,
  );
  assert.equal(
    isAtLeast18(
      birthDate,
      new Date("2026-07-26T16:00:00.000Z"),
      "Asia/Shanghai",
    ),
    true,
  );
});

test("questionnaire rejects timestamp birth dates whose offsets can shift the calendar day", () => {
  const common = {
    track: "short_term" as const,
    ageConfirmed18Plus: true as const,
  };
  assert.equal(
    basicQuestionnaireSchema.safeParse({
      ...common,
      birthDate: "1990-01-01T00:00:00+08:00",
    }).success,
    false,
  );
  assert.equal(
    basicQuestionnaireSchema.safeParse({
      ...common,
      birthDate: "1990-01-01",
    }).success,
    true,
  );
});
