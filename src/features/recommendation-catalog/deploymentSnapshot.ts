import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { verifyCatalogSnapshot, type CatalogSnapshotManifest } from "./snapshot.js";

const snapshotDirectory = process.env.RECOMMENDATION_CATALOG_SNAPSHOT_DIR
  ? resolve(process.env.RECOMMENDATION_CATALOG_SNAPSHOT_DIR)
  : resolve(import.meta.dirname, "../../../data/recommendation-catalog");

const sourceFiles = [
  "styles-cn.json",
  "hairstyles-cn.json",
  "style-hairstyle-relations-cn.json",
  "fit-rules-cn.json",
  "hairstyle-render-schema-v1.json",
  "wardrobe-items-cn.json",
  "style-wardrobe-profiles-cn.json",
  "wardrobe-image-assets-cn.json",
  "wardrobe-supply-map-cn.json",
] as const;

function loadJson(fileName: string): unknown {
  return JSON.parse(readFileSync(resolve(snapshotDirectory, fileName), "utf8"));
}

function loadSnapshot() {
  const sources = Object.fromEntries(sourceFiles.map((fileName) => [
    fileName,
    readFileSync(resolve(snapshotDirectory, fileName), "utf8"),
  ]));
  const manifest = loadJson("manifest.json") as CatalogSnapshotManifest;
  verifyCatalogSnapshot({ manifest, sources });
  return {
    manifest,
    styles: JSON.parse(sources["styles-cn.json"]) as { styles: unknown[] },
    hairstyles: JSON.parse(sources["hairstyles-cn.json"]) as unknown[],
    hairstyleRelations: JSON.parse(sources["style-hairstyle-relations-cn.json"]) as { relations: unknown[]; servingGate?: unknown },
    fitRules: JSON.parse(sources["fit-rules-cn.json"]) as { rules: unknown[]; status?: string },
    hairstyleRenderSchema: JSON.parse(sources["hairstyle-render-schema-v1.json"]),
    wardrobeItems: JSON.parse(sources["wardrobe-items-cn.json"]) as { items: unknown[] },
    wardrobeProfiles: JSON.parse(sources["style-wardrobe-profiles-cn.json"]) as { profiles: unknown[] },
    wardrobeAssets: JSON.parse(sources["wardrobe-image-assets-cn.json"]) as { items: unknown[] },
    wardrobeSupply: JSON.parse(sources["wardrobe-supply-map-cn.json"]) as { entries: unknown[] },
  };
}

/**
 * The only runtime catalog entry point. It intentionally reads no `client/`
 * path; deployment must first run the snapshot builder and package this data
 * directory alongside the server process.
 */
export const recommendationCatalogSnapshot = loadSnapshot();
