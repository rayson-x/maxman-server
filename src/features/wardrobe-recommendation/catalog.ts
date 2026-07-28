import { recommendationCatalogSnapshot } from "../recommendation-catalog/deploymentSnapshot.js";

type Item = {
  id: string; nameZh: string; category: string;
  usage: { seasons: string[]; scenes: string[]; formality: number; maintenance: string; budgetBand: string };
  styleAffinities: Array<{ styleId: string; strength: "core" | "compatible" | string }>;
  softFitSignals?: Record<string, string>;
};
type Formula = { id: string; styleId: string; nameZh: string; compositionLogic: string; sourceSeasonScene: string; slots: Array<{ slot: string; min: number; allowedItemIds: string[] }> };
type Profile = { styleId: string; styleNameZh: string; formulaTemplates: Formula[] };
type Asset = { wardrobeItemId: string; localPath: string; displayStatus: string; virtualTryOn: { status: string } };
type Supply = { wardrobeItemId: string; supplyCandidates: Array<{ brandLineId: string; sourceUrl: string; status: string; rationale: string }> };

const items = (recommendationCatalogSnapshot.wardrobeItems as { items: Item[] }).items;
const profiles = (recommendationCatalogSnapshot.wardrobeProfiles as { profiles: Profile[] }).profiles;
const assets = (recommendationCatalogSnapshot.wardrobeAssets as { items: Asset[] }).items;
const supply = (recommendationCatalogSnapshot.wardrobeSupply as { entries: Supply[] }).entries;

export const wardrobeCatalog = {
  manifestVersion: recommendationCatalogSnapshot.manifest.manifestVersion,
  version: recommendationCatalogSnapshot.manifest.sources.wardrobeItems.datasetVersion,
  itemsById: new Map(items.map((item) => [item.id, item])),
  profilesByStyleId: new Map(profiles.map((profile) => [profile.styleId, profile])),
  assetsByItemId: new Map(assets.map((asset) => [asset.wardrobeItemId, asset])),
  supplyByItemId: new Map(supply.map((entry) => [entry.wardrobeItemId, entry.supplyCandidates])),
  profiles,
};

export type WardrobeCatalogItem = Item;
export type WardrobeCatalogFormula = Formula;
export type WardrobeCatalogProfile = Profile;
