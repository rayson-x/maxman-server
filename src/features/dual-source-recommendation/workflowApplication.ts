import type { PrismaClient } from "../../generated/prisma/client.js";
import { createPhotoAccessService } from "../../services/photoAccessService.js";
import { recommendationCatalogSnapshot } from "../recommendation-catalog/deploymentSnapshot.js";
import type { HairSignals } from "../appearance-agent/rules/hairConstraints.js";
import { createDualSourceCandidateStore } from "./candidateStore.js";
import type { CommonRecommendationInput, DualSourceResult } from "./engine.js";
import { createDualSourceRecommendationPersistence } from "./persistence.js";
import { createDualSourceProviderAdapter } from "./providerAdapter.js";
import { createDualSourceRecommendationTools } from "./tools.js";
import { createZhipuDualSourceChannelProvider } from "./zhipuChannelProvider.js";

type OriginalPhoto = { id: string; storageKey: string };

type BaseStageInput = {
  userId: string;
  planId: string;
  jobId: string;
  generation: number;
  originalPhotos: OriginalPhoto[];
  profileSnapshotRef: string;
  appearanceAnalysisRef?: string;
  questionnaireSnapshotRef?: string;
  userContext: Record<string, unknown>;
  selectedUpstream: Record<string, string>;
};

/**
 * Worker-facing application boundary. It signs only original photo assets for
 * the model invocation and gives workflow code only the three domain methods;
 * no route or job handler can call A/B channels directly.
 */
export function createDualSourceWorkflowApplication(
  prisma: PrismaClient,
  options: { enqueueReviewer?: (comparisonId: string) => Promise<void> } = {},
) {
  const photoAccess = createPhotoAccessService(prisma);

  async function toolsFor(input: BaseStageInput) {
    const originalPhotoReadUrls = await Promise.all(input.originalPhotos.map(async (photo) => (
      await photoAccess.issueReadUrl({
        storageKey: photo.storageKey,
        photoId: photo.id,
        accessorType: "system_provider",
        accessorId: input.jobId,
        purpose: "双源多模态推荐",
        expiresSeconds: 900,
      })
    ).url));
    const commonInput: CommonRecommendationInput = {
      profileSnapshotRef: input.profileSnapshotRef,
      originalAssetRefs: input.originalPhotos.map((photo) => photo.id),
      selectedUpstream: input.selectedUpstream,
      userContext: input.userContext,
      model: {
        provider: "zhipu",
        model: process.env.DUAL_SOURCE_RECOMMENDATION_MODEL ?? "glm-4.6v",
        temperature: 0.2,
        tokenLimit: 900,
        // The current Zhipu function-calling endpoint exposes no stable seed.
        // Persist this so a diff is never presented as solely catalog-caused.
        supportsSeed: false,
      },
    };
    const adapter = createDualSourceProviderAdapter({
      contextByteBudget: Number(process.env.DUAL_SOURCE_CONTEXT_BYTE_BUDGET ?? "24000"),
      maxMainCandidates: 3,
      channelTimeoutMs: Number(process.env.DUAL_SOURCE_CHANNEL_TIMEOUT_MS ?? "10000"),
      invoke: createZhipuDualSourceChannelProvider({ originalPhotoReadUrls }),
    });
    const tools = createDualSourceRecommendationTools({
      adapter,
      persistence: createDualSourceRecommendationPersistence(prisma),
      candidateStore: createDualSourceCandidateStore(prisma),
    });
    return {
      tools,
      shared: {
        ...input,
        commonInput,
        catalogManifestVersion: recommendationCatalogSnapshot.manifest.manifestVersion,
        promptVersion: "dual-source-prompt-v1",
        schemaVersion: "dual-source-domain-v1",
        recommendationContextRef: `analysis-job:${input.jobId}`,
      },
    };
  }

  async function scheduleReviewer(input: { planId: string; domain: string; generation: number; computationKey: string }, result: DualSourceResult) {
    if (result.audit.diff.severity !== "high" || !options.enqueueReviewer) return;
    const comparison = await prisma.recommendationComparisonLog.findUnique({
      where: {
        planId_domain_generation_computationKey: {
          planId: input.planId,
          domain: input.domain,
          generation: input.generation,
          computationKey: input.computationKey,
        },
      },
      select: { id: true },
    });
    if (comparison) {
      // The user result is already persisted and must not be rolled back if a
      // best-effort reviewer enqueue has a transient Redis failure.
      try {
        await options.enqueueReviewer(comparison.id);
      } catch {
        // `reviewerStatus=pending` remains observable and can be replayed by
        // operations; no candidate or exposure is altered.
      }
    }
  }

  return {
    async recommendStyleDirections(input: BaseStageInput): Promise<DualSourceResult> {
      const { tools, shared } = await toolsFor(input);
      const computationKey = `style:${input.jobId}`;
      const result = await tools.recommendStyleDirections({
        ...shared,
        computationKey,
      });
      await scheduleReviewer({ planId: input.planId, domain: "style", generation: input.generation, computationKey }, result);
      return result;
    },

    async recommendHairstyles(input: BaseStageInput & {
      selectedStyleId: string;
      hairSignals: HairSignals;
      renderProvider: string;
      renderModel: string;
    }): Promise<DualSourceResult> {
      const { tools, shared } = await toolsFor(input);
      const computationKey = `hairstyle:${input.jobId}`;
      const result = await tools.recommendHairstyles({
        ...shared,
        computationKey,
        selectedStyleId: input.selectedStyleId,
        hairSignals: input.hairSignals,
        renderProvider: input.renderProvider,
        renderModel: input.renderModel,
      });
      await scheduleReviewer({ planId: input.planId, domain: "hairstyle", generation: input.generation, computationKey }, result);
      return result;
    },

    async recommendWardrobe(input: BaseStageInput & {
      selectedStyleId: string;
      selectedHairstyleId: string;
    }): Promise<DualSourceResult> {
      const { tools, shared } = await toolsFor(input);
      const computationKey = `wardrobe:${input.jobId}`;
      const result = await tools.recommendWardrobe({
        ...shared,
        computationKey,
        selectedStyleId: input.selectedStyleId,
        selectedHairstyleId: input.selectedHairstyleId,
      });
      await scheduleReviewer({ planId: input.planId, domain: "wardrobe", generation: input.generation, computationKey }, result);
      return result;
    },
  };
}
