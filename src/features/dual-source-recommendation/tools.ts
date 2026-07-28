import type { HairSignals } from "../appearance-agent/rules/hairConstraints.js";
import {
  recallRuntimeHairstyles,
  recallRuntimeStyleDirections,
  recallRuntimeWardrobe,
} from "./catalogRecall.js";
import type { CommonRecommendationInput, DomainCandidate, DualSourceResult, RecommendationDomain } from "./engine.js";
import type { createDualSourceProviderAdapter } from "./providerAdapter.js";
import type { createDualSourceRecommendationPersistence } from "./persistence.js";
import type { createDualSourceCandidateStore } from "./candidateStore.js";

type SharedToolInput = {
  userId: string;
  planId: string;
  generation: number;
  computationKey: string;
  commonInput: CommonRecommendationInput;
  profileSnapshotRef: string;
  appearanceAnalysisRef?: string | null;
  questionnaireSnapshotRef?: string | null;
  recommendationContextRef?: string | null;
  catalogManifestVersion?: string | null;
  promptVersion: string;
  schemaVersion: string;
};

type ProviderAdapter = ReturnType<typeof createDualSourceProviderAdapter>;
type Persistence = ReturnType<typeof createDualSourceRecommendationPersistence>;
type CandidateStore = ReturnType<typeof createDualSourceCandidateStore>;

function fallback(recalled: Parameters<ProviderAdapter["recommend"]>[0]["recalled"]): DomainCandidate[] {
  return recalled.map((row, index) => ({ ...row.candidate, rank: index + 1, systemSupported: true }));
}

async function run(
  adapter: ProviderAdapter,
  persistence: Persistence,
  input: SharedToolInput & {
    domain: RecommendationDomain;
    recalled: Parameters<ProviderAdapter["recommend"]>[0]["recalled"];
    rules: unknown[];
    catalogAvailable?: boolean;
    selectedStyleId?: string;
  },
  candidateStore?: CandidateStore,
): Promise<DualSourceResult> {
  const result = await adapter.recommend({
    domain: input.domain,
    commonInput: input.commonInput,
    recalled: input.recalled,
    rules: input.rules,
    deterministicFallback: fallback(input.recalled),
    catalogAvailable: input.catalogAvailable,
  });
  const stored = candidateStore && input.domain !== "style"
    ? await candidateStore.store({
        planId: input.planId,
        domain: input.domain,
        generation: input.generation,
        computationKey: input.computationKey,
        candidates: [...result.main, ...result.exploration],
        selectedStyleId: input.selectedStyleId,
      })
    : undefined;
  await persistence.persist({
    userId: input.userId,
    planId: input.planId,
    domain: input.domain,
    generation: input.generation,
    computationKey: input.computationKey,
    commonInput: input.commonInput,
    appearanceAnalysisRef: input.appearanceAnalysisRef,
    questionnaireSnapshotRef: input.questionnaireSnapshotRef,
    recommendationContextRef: input.recommendationContextRef,
    catalogManifestVersion: input.catalogManifestVersion,
    promptVersion: input.promptVersion,
    schemaVersion: input.schemaVersion,
    recommendationSetId: stored?.recommendationSetId,
    candidateRecordIds: stored?.candidateRecordIds,
    result,
  });
  return result;
}

/**
 * The only public recommendation boundary. Workflow and Agent integrations
 * receive these domain methods, never raw A/B invocation, recall, diff, or
 * reviewer dependencies.
 */
export function createDualSourceRecommendationTools(deps: {
  adapter: ProviderAdapter;
  persistence: Persistence;
  candidateStore?: CandidateStore;
}) {
  const { adapter, persistence, candidateStore } = deps;
  return {
    async recommendStyleDirections(input: SharedToolInput & { catalogAvailable?: boolean }) {
      return run(adapter, persistence, {
        ...input,
        domain: "style",
        recalled: recallRuntimeStyleDirections(),
        rules: [],
        catalogAvailable: input.catalogAvailable,
      }, candidateStore);
    },

    async recommendHairstyles(input: SharedToolInput & {
      selectedStyleId: string | null | undefined;
      hairSignals: HairSignals;
      renderProvider: string;
      renderModel: string;
      catalogAvailable?: boolean;
    }) {
      if (!input.selectedStyleId) throw new Error("style_not_selected");
      const recalled = recallRuntimeHairstyles({
        selectedStyleId: input.selectedStyleId,
        hairSignals: input.hairSignals,
        renderProvider: input.renderProvider,
        renderModel: input.renderModel,
      });
      const computationKey = input.computationKey;
      const result = await run(adapter, persistence, {
        ...input,
        domain: "hairstyle",
        recalled: recalled.candidates,
        // The production fit-rule gate is intentionally not ready. The recall
        // projection returns [] while physical feasibility has already run.
        rules: recalled.appliedRules,
        catalogAvailable: input.catalogAvailable,
        selectedStyleId: input.selectedStyleId,
      }, candidateStore);
      if (recalled.catalogCoverage === "partial") {
        await persistence.recordCatalogGap({
          planId: input.planId,
          domain: "hairstyle",
          generation: input.generation,
          computationKey,
          conceptItemId: input.selectedStyleId,
          reason: "incomplete_hairstyle_relation_coverage",
        });
      }
      return result;
    },

    async recommendWardrobe(input: SharedToolInput & {
      selectedStyleId: string | null | undefined;
      selectedHairstyleId: string | null | undefined;
      catalogAvailable?: boolean;
    }) {
      if (!input.selectedStyleId) throw new Error("style_not_selected");
      if (!input.selectedHairstyleId) throw new Error("hairstyle_not_selected");
      return run(adapter, persistence, {
        ...input,
        domain: "wardrobe",
        recalled: recallRuntimeWardrobe({ selectedStyleId: input.selectedStyleId }),
        rules: [],
        catalogAvailable: input.catalogAvailable,
        selectedStyleId: input.selectedStyleId,
      }, candidateStore);
    },
  };
}
