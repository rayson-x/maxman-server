import assert from "node:assert/strict";
import test from "node:test";
import { projectHairstyleCatalog, type HairstyleCatalogInput } from "./hairstyleReadiness.js";

const catalog: HairstyleCatalogInput = {
  hairstyles: [
    {
      id: "hair-covered",
      nameZh: "覆盖额头的测试发型",
      recommendationEligibility: "default",
      personalizedRenderReadiness: "missing_render_spec",
      fitAttributes: { foreheadCoverage: { value: "full" } },
      feasibilityAttributes: { volumeRequirement: { value: "low" } },
    },
    {
      id: "hair-exposed-high-volume",
      nameZh: "露额高发量测试发型",
      recommendationEligibility: "default",
      personalizedRenderReadiness: "ready",
      fitAttributes: { foreheadCoverage: { value: "none" } },
      feasibilityAttributes: { volumeRequirement: { value: "high" } },
      renderVariants: [{ provider: "ark", model: "seedream", calibrationStatus: "render_validated" }],
    },
    {
      id: "hair-special",
      nameZh: "特殊意愿发型",
      recommendationEligibility: "special_opt_in",
      personalizedRenderReadiness: "ready",
      fitAttributes: { foreheadCoverage: { value: "full" } },
      feasibilityAttributes: { volumeRequirement: { value: "low" } },
      renderVariants: [{ provider: "ark", model: "seedream", calibrationStatus: "render_validated" }],
    },
  ],
  relations: [
    { styleId: "underfed-style", hairstyleId: "hair-covered", recommendationPolicy: { eligible: true, pool: "normal" } },
    { styleId: "underfed-style", hairstyleId: "hair-exposed-high-volume", recommendationPolicy: { eligible: true, pool: "normal" } },
    { styleId: "underfed-style", hairstyleId: "hair-special", recommendationPolicy: { eligible: true, pool: "special_opt_in" } },
  ],
  underfedStyles: [{ styleId: "underfed-style" }],
  fitRulesProductionPassed: false,
};

test("underfed relations stay text-selectable but do not claim catalog verification or inject draft fit rules", () => {
  const result = projectHairstyleCatalog(catalog, {
    selectedStyleId: "underfed-style",
    hairSignals: { hairline: "normal", volume: "medium" },
    renderProvider: "ark",
    renderModel: "seedream",
  });

  assert.equal(result.catalogCoverage, "partial");
  assert.equal(result.appliedFitRules.length, 0);
  assert.deepEqual(result.candidates.map((candidate) => candidate.hairstyleId), [
    "hair-covered",
    "hair-exposed-high-volume",
  ]);
  assert.equal(result.candidates[0]?.verificationStatus, "not_checked");
  assert.equal(result.candidates[0]?.rendering.status, "not_calibrated");
  assert.equal(result.candidates[1]?.rendering.status, "ready");
});

test("physical hair constraints remain active while draft fit rules project zero effects", () => {
  const result = projectHairstyleCatalog(catalog, {
    selectedStyleId: "underfed-style",
    hairSignals: { hairline: "receding", volume: "thin" },
    renderProvider: "ark",
    renderModel: "seedream",
  });

  assert.deepEqual(result.candidates.map((candidate) => candidate.hairstyleId), ["hair-covered"]);
  assert.deepEqual(result.excluded.map((candidate) => candidate.hairstyleId), ["hair-exposed-high-volume"]);
  assert.equal(result.appliedFitRules.length, 0);
});

test("special-opt-in hairstyles never enter default or exploration recall", () => {
  const result = projectHairstyleCatalog(catalog, {
    selectedStyleId: "underfed-style",
    hairSignals: { hairline: "normal", volume: "medium" },
    renderProvider: "ark",
    renderModel: "seedream",
  });

  assert.equal(result.candidates.some((candidate) => candidate.hairstyleId === "hair-special"), false);
});
