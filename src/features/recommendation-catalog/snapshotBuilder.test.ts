import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

test("deployment snapshot builder records all validated client catalogs and the production rule gate", async () => {
  const serverRoot = resolve(import.meta.dirname, "../../..");
  const output = await mkdtemp(resolve(tmpdir(), "bettermeet-catalog-snapshot-"));
  try {
    const result = spawnSync(process.execPath, [
      resolve(serverRoot, "scripts/build-recommendation-catalog-snapshot.mjs"),
      "--output", output,
    ], {
      cwd: serverRoot,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const manifest = JSON.parse(await readFile(resolve(output, "manifest.json"), "utf8"));
    // 穿搭域接入后快照从 10 个源涨到 13 个；这里跟着数据走，不然构建器与加载器会各说一套。
    assert.deepEqual(Object.keys(manifest.sources).sort(), [
      "fitRules",
      "fitRulesBodyOutfit",
      "hairstyleRenderSchema",
      "hairstyleRelations",
      "hairstylePreviewCalibrations",
      "hairstyles",
      "outfitFitSchema",
      "outfits",
      "styles",
      "wardrobeAssets",
      "wardrobeItems",
      "wardrobeProfiles",
      "wardrobeSupply",
    ].sort());
    assert.equal(manifest.validators["fit-rules-production"].passed, false);
    assert.equal(manifest.validators["fit-rules-production"].readinessGate, true);
    assert.equal(manifest.validators["fit-rules-compile"].passed, true);
    assert.match(manifest.sources.hairstyles.datasetVersion, /^content-sha256:/);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
