import assert from "node:assert/strict";
import test from "node:test";
import {
  createCatalogSnapshotManifest,
  verifyCatalogSnapshot,
  type SnapshotSource,
} from "./snapshot.js";

const sources: SnapshotSource[] = [
  {
    id: "styles",
    fileName: "styles-cn.json",
    contents: JSON.stringify({ datasetVersion: "styles-v1", styles: [] }),
  },
  {
    id: "hairstyles",
    fileName: "hairstyles-cn.json",
    contents: JSON.stringify([{ id: "hair-1", nameZh: "测试发型" }]),
  },
];

const passingValidators = [
  { id: "style-catalog", version: "test-v1", passed: true },
  { id: "fit-rules-compile", version: "test-v1", passed: true },
  { id: "fit-rules-production", version: "test-v1", passed: false, readinessGate: true },
];

test("creates a manifest with source hashes and a content-derived version for array catalogs", () => {
  const manifest = createCatalogSnapshotManifest({
    sources,
    validators: passingValidators,
    builtAt: "2026-07-28T00:00:00.000Z",
  });

  assert.equal(manifest.sources.styles.datasetVersion, "styles-v1");
  assert.match(manifest.sources.hairstyles.datasetVersion, /^content-sha256:/);
  assert.match(manifest.sources.hairstyles.sha256, /^[a-f0-9]{64}$/);
  assert.equal(manifest.validators["fit-rules-production"]?.passed, false);
  assert.equal(manifest.validators["fit-rules-production"]?.readinessGate, true);
});

test("rejects a manifest when a required structural validator has not passed", () => {
  assert.throws(
    () => createCatalogSnapshotManifest({
      sources,
      validators: passingValidators.map((validator) =>
        validator.id === "style-catalog" ? { ...validator, passed: false } : validator,
      ),
      builtAt: "2026-07-28T00:00:00.000Z",
    }),
    /style-catalog.*passed/i,
  );
});

test("rejects a runtime snapshot whose copied catalog no longer matches its manifest hash", () => {
  const manifest = createCatalogSnapshotManifest({
    sources,
    validators: passingValidators,
    builtAt: "2026-07-28T00:00:00.000Z",
  });

  assert.throws(
    () => verifyCatalogSnapshot({
      manifest,
      sources: {
        "styles-cn.json": sources[0]!.contents,
        "hairstyles-cn.json": JSON.stringify([{ id: "hair-1", nameZh: "被手改的发型" }]),
      },
    }),
    /hash mismatch/i,
  );
});
