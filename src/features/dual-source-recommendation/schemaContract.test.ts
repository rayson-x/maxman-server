import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const schema = readFileSync(resolve(import.meta.dirname, "../../../prisma/schema.prisma"), "utf8");

test("schema keeps dual-source comparison, channel, exposure, choice, outcome, reviewer, and catalog-gap records separate", () => {
  for (const model of [
    "RecommendationComparisonLog",
    "RecommendationChannelRun",
    "RecommendationExposure",
    "RecommendationChoice",
    "RecommendationOutcome",
    "RecommendationReviewerResult",
    "CatalogGap",
    "AssetGenerationQueue",
    "ConceptCatalogMapping",
  ]) {
    assert.match(schema, new RegExp(`model ${model}\\s+\\{`));
  }
  assert.match(schema, /enum RecommendationReviewerStatus/);
  assert.match(schema, /enum RecommendationOutcomeType/);
  assert.match(schema, /userId\s+String[\s\S]*?@relation\(fields: \[userId\], references: \[id\], onDelete: Cascade\)/);
  assert.match(schema, /@@unique\(\[comparisonId, channel\]\)/);
});
