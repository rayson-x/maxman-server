import { readFileSync } from "node:fs";
import manifestDocument from "./data/generated/manifest.json" with { type: "json" };
import stylesDocument from "./data/generated/styles-cn.json" with { type: "json" };
import hairstylesDocument from "./data/generated/hairstyles-cn.json" with { type: "json" };
import hairstyleRelationsDocument from "./data/generated/style-hairstyle-relations-cn.json" with { type: "json" };
import fitRulesDocument from "./data/generated/fit-rules-cn.json" with { type: "json" };
import hairstyleRenderSchemaDocument from "./data/generated/hairstyle-render-schema-v1.json" with { type: "json" };
import wardrobeItemsDocument from "./data/generated/wardrobe-items-cn.json" with { type: "json" };
import wardrobeProfilesDocument from "./data/generated/style-wardrobe-profiles-cn.json" with { type: "json" };
import wardrobeAssetsDocument from "./data/generated/wardrobe-image-assets-cn.json" with { type: "json" };
import wardrobeSupplyDocument from "./data/generated/wardrobe-supply-map-cn.json" with { type: "json" };
import { verifyCatalogSnapshot, type CatalogSnapshotManifest } from "./snapshot.js";

const importedDocuments = {
  "styles-cn.json": stylesDocument,
  "hairstyles-cn.json": hairstylesDocument,
  "style-hairstyle-relations-cn.json": hairstyleRelationsDocument,
  "fit-rules-cn.json": fitRulesDocument,
  "hairstyle-render-schema-v1.json": hairstyleRenderSchemaDocument,
  "wardrobe-items-cn.json": wardrobeItemsDocument,
  "style-wardrobe-profiles-cn.json": wardrobeProfilesDocument,
  "wardrobe-image-assets-cn.json": wardrobeAssetsDocument,
  "wardrobe-supply-map-cn.json": wardrobeSupplyDocument,
};

function generatedContents(fileName: string): string {
  return readFileSync(new URL(`./data/generated/${fileName}`, import.meta.url), "utf8");
}

function loadSnapshot() {
  const sources = Object.fromEntries(
    Object.entries(importedDocuments).map(([fileName, imported]) => {
      const contents = generatedContents(fileName);
      // The imports make TypeScript copy these assets into dist. This semantic
      // check prevents a packaging mismatch between the copied JSON and the
      // bytes verified against the source hash below.
      if (JSON.stringify(JSON.parse(contents)) !== JSON.stringify(imported)) {
        throw new Error(`Deployment snapshot import mismatch: ${fileName}`);
      }
      return [fileName, contents];
    }),
  );
  const manifest = manifestDocument as CatalogSnapshotManifest;
  verifyCatalogSnapshot({ manifest, sources });
  return {
    manifest,
    styles: stylesDocument as { styles: unknown[] },
    hairstyles: hairstylesDocument as unknown[],
    hairstyleRelations: hairstyleRelationsDocument as { relations: unknown[]; servingGate?: unknown },
    fitRules: fitRulesDocument as { rules: unknown[]; status?: string },
    hairstyleRenderSchema: hairstyleRenderSchemaDocument,
    wardrobeItems: wardrobeItemsDocument as { items: unknown[] },
    wardrobeProfiles: wardrobeProfilesDocument as { profiles: unknown[] },
    wardrobeAssets: wardrobeAssetsDocument as { items: unknown[] },
    wardrobeSupply: wardrobeSupplyDocument as { entries: unknown[] },
  };
}

/**
 * The only runtime catalog entry point. It intentionally reads no `client/`
 * path; deployment must first run the snapshot builder.
 */
export const recommendationCatalogSnapshot = loadSnapshot();
