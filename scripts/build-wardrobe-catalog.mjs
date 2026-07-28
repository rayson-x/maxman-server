import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const source = resolve(root, "client/data/style-annotation");
const target = resolve(root, "server/src/features/wardrobe-recommendation/data/generated");
const files = [
  "wardrobe-items-cn.json",
  "style-wardrobe-profiles-cn.json",
  "wardrobe-image-assets-cn.json",
  "wardrobe-supply-map-cn.json",
];

await mkdir(target, { recursive: true });
for (const file of files) {
  const parsed = JSON.parse(await readFile(resolve(source, file), "utf8"));
  if (!Array.isArray(parsed.items) && !Array.isArray(parsed.profiles) && !Array.isArray(parsed.entries)) {
    throw new Error(`${file} is not a recognized wardrobe catalog document`);
  }
  await writeFile(resolve(target, file), `${JSON.stringify(parsed, null, 2)}\n`);
}

const items = JSON.parse(await readFile(resolve(target, files[0]), "utf8")).items;
const profiles = JSON.parse(await readFile(resolve(target, files[1]), "utf8")).profiles;
const assets = JSON.parse(await readFile(resolve(target, files[2]), "utf8")).items;
const supplyEntries = JSON.parse(await readFile(resolve(target, files[3]), "utf8")).entries;
const itemIds = new Set(items.map((item) => item.id));
if (itemIds.size !== items.length) throw new Error("Duplicate wardrobe item ID");
for (const profile of profiles) for (const formula of profile.formulaTemplates) for (const slot of formula.slots) {
  for (const id of slot.allowedItemIds) if (!itemIds.has(id)) throw new Error(`Unknown wardrobe item ${id} in ${formula.id}`);
}
for (const asset of assets) if (!itemIds.has(asset.wardrobeItemId)) throw new Error(`Unknown wardrobe asset ${asset.wardrobeItemId}`);
if (new Set(assets.map((asset) => asset.wardrobeItemId)).size !== assets.length) throw new Error("Duplicate wardrobe asset ID");
for (const entry of supplyEntries) if (!itemIds.has(entry.wardrobeItemId)) throw new Error(`Unknown wardrobe supply ${entry.wardrobeItemId}`);
console.log(`Built wardrobe catalog: ${items.length} items, ${profiles.length} styles, ${assets.length} assets.`);
