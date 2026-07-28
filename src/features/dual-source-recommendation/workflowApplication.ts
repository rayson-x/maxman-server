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
export function createDualSourceWorkflowApplication(prisma: PrismaClient) {
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

  return {
    async recommendStyleDirections(input: BaseStageInput): Promise<DualSourceResult> {
      const { tools, shared } = await toolsFor(input);
      return tools.recommendStyleDirections({
        ...shared,
        computationKey: `style:${input.jobId}`,
      });
    },

    async recommendHairstyles(input: BaseStageInput & {
      selectedStyleId: string;
      hairSignals: HairSignals;
      renderProvider: string;
      renderModel: string;
    }): Promise<DualSourceResult> {
      const { tools, shared } = await toolsFor(input);
      return tools.recommendHairstyles({
        ...shared,
        computationKey: `hairstyle:${input.jobId}`,
        selectedStyleId: input.selectedStyleId,
        hairSignals: input.hairSignals,
        renderProvider: input.renderProvider,
        renderModel: input.renderModel,
      });
    },

    async recommendWardrobe(input: BaseStageInput & {
      selectedStyleId: string;
      selectedHairstyleId: string;
    }): Promise<DualSourceResult> {
      const { tools, shared } = await toolsFor(input);
      return tools.recommendWardrobe({
        ...shared,
        computationKey: `wardrobe:${input.jobId}`,
        selectedStyleId: input.selectedStyleId,
        selectedHairstyleId: input.selectedHairstyleId,
      });
    },
  };
}

