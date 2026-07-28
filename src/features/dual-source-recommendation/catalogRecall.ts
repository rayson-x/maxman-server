import { Buffer } from "node:buffer";
import { recommendationCatalogSnapshot } from "../recommendation-catalog/deploymentSnapshot.js";
import { projectRuntimeHairstyleCatalog } from "../recommendation-catalog/runtimeHairstyleCatalog.js";
import type { HairSignals } from "../appearance-agent/rules/hairConstraints.js";
import type { RecalledCandidate } from "./engine.js";

function compact(candidate: RecalledCandidate["candidate"]): RecalledCandidate {
  return {
    stableId: candidate.canonicalId,
    bytes: Buffer.byteLength(JSON.stringify(candidate), "utf8"),
    candidate,
  };
}

/** B-channel style recall: all deployed style directions, never a business Top-K. */
export function recallRuntimeStyleDirections(): RecalledCandidate[] {
  const styles = recommendationCatalogSnapshot.styles as unknown as {
    styles: Array<{ id: string; nameZh: string; description: string; visualPrinciples?: string[] }>;
  };
  return styles.styles
    .map((style) => compact({
      id: style.id,
      canonicalId: style.id,
      rank: 0,
      nameZh: style.nameZh,
      rationale: style.description,
      systemSupported: true,
      hardConflict: false,
    }))
    .sort((a, b) => a.stableId.localeCompare(b.stableId));
}

export function recallRuntimeHairstyles(input: {
  selectedStyleId: string;
  hairSignals: HairSignals;
  renderProvider: string;
  renderModel: string;
}): {
  catalogCoverage: "complete" | "partial";
  appliedRules: [];
  candidates: RecalledCandidate[];
} {
  const projection = projectRuntimeHairstyleCatalog(input);
  return {
    catalogCoverage: projection.catalogCoverage,
    appliedRules: projection.appliedFitRules,
    candidates: projection.candidates.map((hairstyle) => compact({
      id: hairstyle.hairstyleId,
      canonicalId: hairstyle.hairstyleId,
      rank: 0,
      nameZh: hairstyle.nameZh,
      rationale: "目录关系与发际线/发量可行性约束已纳入。",
      systemSupported: hairstyle.verificationStatus === "catalog_verified",
      hardConflict: false,
    })).sort((a, b) => a.stableId.localeCompare(b.stableId)),
  };
}

/** B-channel wardrobe recall: formulas for the user's explicit selected style only. */
export function recallRuntimeWardrobe(input: { selectedStyleId: string }): RecalledCandidate[] {
  const profiles = recommendationCatalogSnapshot.wardrobeProfiles as unknown as {
    profiles: Array<{
      styleId: string;
      styleNameZh: string;
      formulaTemplates: Array<{
        id: string;
        nameZh: string;
        compositionLogic: string;
        sourceSeasonScene: string;
        slots: Array<{ slot: string; min: number; max: number }>;
      }>;
    }>;
  };
  const profile = profiles.profiles.find((row) => row.styleId === input.selectedStyleId);
  if (!profile) throw new Error(`No deployed wardrobe profile for selected style ${input.selectedStyleId}`);
  return profile.formulaTemplates
    .map((formula) => compact({
      id: formula.id,
      canonicalId: formula.id,
      rank: 0,
      nameZh: formula.nameZh,
      rationale: formula.compositionLogic,
      systemSupported: true,
      hardConflict: false,
    }))
    .sort((a, b) => a.stableId.localeCompare(b.stableId));
}
