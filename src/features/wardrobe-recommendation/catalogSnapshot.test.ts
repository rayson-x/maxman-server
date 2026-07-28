import assert from "node:assert/strict";
import test from "node:test";
import { wardrobeCatalog } from "./catalog.js";
import { recommendationCatalogSnapshot } from "../recommendation-catalog/deploymentSnapshot.js";

test("system wardrobe reads the verified deployment snapshot instead of its own editable JSON copy", () => {
  assert.equal(wardrobeCatalog.manifestVersion, recommendationCatalogSnapshot.manifest.manifestVersion);
  assert.equal(wardrobeCatalog.version, recommendationCatalogSnapshot.wardrobeItems.items.length > 0
    ? recommendationCatalogSnapshot.manifest.sources.wardrobeItems.datasetVersion
    : "");
});
