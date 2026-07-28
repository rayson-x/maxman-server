import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const serverRoot = resolve(workspaceRoot, "server");
const clientRoot = resolve(workspaceRoot, "client");
const defaultOutput = resolve(serverRoot, "data/recommendation-catalog");
const outputIndex = process.argv.indexOf("--output");
const output = outputIndex >= 0 ? resolve(process.cwd(), process.argv[outputIndex + 1] ?? "") : defaultOutput;

const sources = [
  ["styles", "styles-cn.json"],
  ["hairstyles", "hairstyles-cn.json"],
  ["hairstyleRelations", "style-hairstyle-relations-cn.json"],
  ["fitRules", "fit-rules-cn.json"],
  ["hairstyleRenderSchema", "hairstyle-render-schema-v1.json"],
  ["wardrobeItems", "wardrobe-items-cn.json"],
  ["wardrobeProfiles", "style-wardrobe-profiles-cn.json"],
  ["wardrobeAssets", "wardrobe-image-assets-cn.json"],
  ["wardrobeSupply", "wardrobe-supply-map-cn.json"],
];

const hash = (contents) => createHash("sha256").update(contents).digest("hex");
const snapshotHash = (contents) => hash(JSON.stringify(JSON.parse(contents)));
const datasetVersion = (contents) => {
  const document = JSON.parse(contents);
  if (document && !Array.isArray(document) && typeof document === "object") {
    if (typeof document.datasetVersion === "string" && document.datasetVersion) return document.datasetVersion;
    if (typeof document.schemaVersion === "string" && document.schemaVersion) return document.schemaVersion;
  }
  return `content-sha256:${snapshotHash(contents)}`;
};

async function validatorVersion(script) {
  return `sha256:${hash(await readFile(resolve(clientRoot, script), "utf8"))}`;
}

async function runValidator({ id, script, args = [], readinessGate = false }) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: clientRoot,
    encoding: "utf8",
  });
  const passed = result.status === 0;
  if (!passed && !readinessGate) {
    throw new Error(`Catalog validator ${id} failed:\n${result.stderr || result.stdout}`);
  }
  return {
    id,
    version: await validatorVersion(script),
    passed,
    ...(readinessGate ? { readinessGate: true } : {}),
  };
}

const validators = await Promise.all([
  runValidator({ id: "system-wardrobe-catalog", script: "scripts/validate-system-wardrobe-catalog.mjs" }),
  runValidator({ id: "wardrobe-image-assets", script: "scripts/validate-wardrobe-image-assets.mjs" }),
  runValidator({ id: "wardrobe-supply-map", script: "scripts/validate-wardrobe-supply-map.mjs" }),
  runValidator({ id: "style-hairstyle-relations", script: "scripts/build-style-hairstyle-relations.mjs", args: ["--check"] }),
  runValidator({ id: "fit-rules-compile", script: "scripts/validate-fit-rules.mjs", args: ["--mode", "compile"] }),
  // The current data deliberately fails this gate. Recording the failure is how
  // runtime code knows to project zero fit rules instead of making a false claim.
  runValidator({ id: "fit-rules-production", script: "scripts/validate-fit-rules.mjs", args: ["--mode", "production"], readinessGate: true }),
]);

const targetSources = {};
const copied = [];
for (const [id, fileName] of sources) {
  const contents = await readFile(resolve(clientRoot, "data/style-annotation", fileName), "utf8");
  JSON.parse(contents);
  targetSources[id] = {
    fileName,
    datasetVersion: datasetVersion(contents),
    sha256: hash(contents),
    snapshotSha256: snapshotHash(contents),
  };
  copied.push([fileName, contents]);
}

await mkdir(output, { recursive: true });
for (const [fileName, contents] of copied) {
  await writeFile(resolve(output, fileName), contents);
}
const manifest = {
  manifestVersion: "recommendation-catalog-snapshot-v1",
  builtAt: new Date().toISOString(),
  sources: targetSources,
  validators: Object.fromEntries(validators.map((validator) => [validator.id, validator])),
};
await writeFile(resolve(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Built recommendation catalog snapshot: ${Object.keys(targetSources).length} sources, ${validators.filter((validator) => validator.passed).length}/${validators.length} validators passed.`);
