import assert from "node:assert/strict";
import test from "node:test";
import { recommendationCatalogSnapshot } from "./deploymentSnapshot.js";

test("runtime recommendation catalog is loaded only from the verified deployment snapshot", () => {
  assert.equal(recommendationCatalogSnapshot.manifest.manifestVersion, "recommendation-catalog-snapshot-v1");
  assert.equal(recommendationCatalogSnapshot.hairstyles.length, 27);
  assert.equal(recommendationCatalogSnapshot.styles.styles.length, 41);
  assert.equal(recommendationCatalogSnapshot.wardrobeItems.items.length, 169);
  assert.equal(recommendationCatalogSnapshot.manifest.validators["fit-rules-production"]?.passed, false);
});
