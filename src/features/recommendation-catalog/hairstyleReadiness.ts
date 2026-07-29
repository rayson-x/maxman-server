import {
  applyHairConstraint,
  computeHairConstraint,
  type HairSignals,
  type HairVolumeRequirement,
} from "../appearance-agent/rules/hairConstraints.js";

type RawHairstyle = {
  id: string;
  nameZh: string;
  recommendationEligibility?: "special_opt_in" | "default";
  personalizedRenderReadiness?: string;
  fitAttributes?: { foreheadCoverage?: { value?: string } };
  feasibilityAttributes?: { volumeRequirement?: { value?: "low" | "medium" | "high" } };
  renderVariants?: Array<{
    provider: string;
    model: string;
    calibrationStatus: string;
  }>;
};

type RawRelation = {
  styleId: string;
  hairstyleId: string;
  recommendationPolicy: {
    eligible: boolean;
    pool: "normal" | "exploration" | "special_opt_in" | "frozen";
  };
};

export type HairstyleCatalogInput = {
  hairstyles: RawHairstyle[];
  relations: RawRelation[];
  underfedStyles: Array<{ styleId: string }>;
  /** The production gate may fail while the snapshot itself remains deployable. */
  fitRulesProductionPassed: boolean;
};

export type HairstyleCatalogProjection = {
  catalogCoverage: "complete" | "partial";
  /** This stays empty until the production fit-rule gate has passed. */
  appliedFitRules: [];
  candidates: Array<{
    hairstyleId: string;
    nameZh: string;
    verificationStatus: "catalog_verified" | "not_checked";
    rendering: { status: "ready" | "not_calibrated" };
  }>;
  /**
   * 被可行性约束剔除的款式。**带出款式名与过滤实际使用的两个属性** —— 下游要靠它们判断
   * 「这一款靠假发能不能拿回来、需要哪一档工艺」。不让下游另找一处重新查这两项：
   * 那会产生第二个真相来源，而这里这份才是过滤真正用过的。
   */
  excluded: Array<{
    hairstyleId: string;
    nameZh: string;
    requiresHairVolume: HairVolumeRequirement;
    coversForehead: boolean;
    reason: string;
  }>;
};

function coversForehead(hairstyle: RawHairstyle): boolean {
  const coverage = hairstyle.fitAttributes?.foreheadCoverage?.value;
  return coverage !== undefined && coverage !== "none";
}

function renderingStatus(
  hairstyle: RawHairstyle,
  provider: string,
  model: string,
): "ready" | "not_calibrated" {
  if (hairstyle.personalizedRenderReadiness !== "ready") return "not_calibrated";
  return hairstyle.renderVariants?.some((variant) =>
    variant.provider === provider &&
    variant.model === model &&
    variant.calibrationStatus === "render_validated",
  ) ? "ready" : "not_calibrated";
}

/**
 * Compact B-channel input for hairstyle relations. It keeps the independently
 * calibrated physical feasibility constraint in code and deliberately does not
 * turn S0/S1 draft fit rules into user-facing system evidence.
 */
export function projectHairstyleCatalog(
  catalog: HairstyleCatalogInput,
  input: {
    selectedStyleId: string;
    hairSignals: HairSignals;
    renderProvider: string;
    renderModel: string;
  },
): HairstyleCatalogProjection {
  const underfed = catalog.underfedStyles.some((row) => row.styleId === input.selectedStyleId);
  const byId = new Map(catalog.hairstyles.map((hairstyle) => [hairstyle.id, hairstyle]));
  const relationCandidates = catalog.relations
    .filter((relation) =>
      relation.styleId === input.selectedStyleId &&
      relation.recommendationPolicy.eligible &&
      relation.recommendationPolicy.pool !== "special_opt_in" &&
      relation.recommendationPolicy.pool !== "frozen",
    )
    .map((relation) => byId.get(relation.hairstyleId))
    .filter((hairstyle): hairstyle is RawHairstyle =>
      hairstyle !== undefined && hairstyle.recommendationEligibility !== "special_opt_in",
    );

  const constrained = applyHairConstraint(
    relationCandidates.map((hairstyle) => ({
      ...hairstyle,
      requiresHairVolume: hairstyle.feasibilityAttributes?.volumeRequirement?.value ?? "medium",
      coversForehead: coversForehead(hairstyle),
    })),
    computeHairConstraint(input.hairSignals),
  );
  const verificationStatus = underfed ? "not_checked" as const : "catalog_verified" as const;
  return {
    catalogCoverage: underfed ? "partial" : "complete",
    // Do not weaken this just because a caller sees a production-ready-looking
    // schema. The failed production validator is the only source of truth here.
    appliedFitRules: [],
    candidates: constrained.kept.map((hairstyle) => ({
      hairstyleId: hairstyle.id,
      nameZh: hairstyle.nameZh,
      verificationStatus,
      rendering: { status: renderingStatus(hairstyle, input.renderProvider, input.renderModel) },
    })),
    excluded: constrained.excluded.map(({ item, reason }) => ({
      hairstyleId: item.id,
      nameZh: item.nameZh,
      requiresHairVolume: item.requiresHairVolume,
      coversForehead: item.coversForehead,
      reason,
    })),
  };
}
