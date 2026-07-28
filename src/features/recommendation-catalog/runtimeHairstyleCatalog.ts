import { recommendationCatalogSnapshot } from "./deploymentSnapshot.js";
import {
  projectHairstyleCatalog,
  type HairstyleCatalogInput,
  type HairstyleCatalogProjection,
} from "./hairstyleReadiness.js";
import type { HairSignals } from "../appearance-agent/rules/hairConstraints.js";

function deploymentHairstyleCatalog(): HairstyleCatalogInput {
  const relations = recommendationCatalogSnapshot.hairstyleRelations as unknown as {
    relations: HairstyleCatalogInput["relations"];
    servingGate?: { underfedStyles?: HairstyleCatalogInput["underfedStyles"] };
  };
  return {
    hairstyles: recommendationCatalogSnapshot.hairstyles as HairstyleCatalogInput["hairstyles"],
    relations: relations.relations,
    underfedStyles: relations.servingGate?.underfedStyles ?? [],
    fitRulesProductionPassed:
      recommendationCatalogSnapshot.manifest.validators["fit-rules-production"]?.passed === true,
  };
}

/** Runtime adapter for B recall; it has no dependency on client source paths or legacy attributes. */
export function projectRuntimeHairstyleCatalog(input: {
  selectedStyleId: string;
  hairSignals: HairSignals;
  renderProvider: string;
  renderModel: string;
}): HairstyleCatalogProjection {
  return projectHairstyleCatalog(deploymentHairstyleCatalog(), input);
}
