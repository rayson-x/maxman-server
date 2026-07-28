import type { PrismaClient } from "../../generated/prisma/client.js";
import type { ChannelResult, CommonRecommendationInput, DomainCandidate, DualSourceResult, RecommendationDomain } from "./engine.js";

type PersistedChannelStatus = "completed" | "failed" | "timed_out" | "reused";

function channelStatus(audit: DualSourceResult["audit"]["channels"]["A"]): PersistedChannelStatus {
  if (audit.reused) return "reused";
  const { status } = audit;
  return status === "completed" || status === "timed_out" ? status : "failed";
}

function isCandidate(value: unknown): value is DomainCandidate {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "string"
    && typeof candidate.canonicalId === "string"
    && typeof candidate.rank === "number"
    && typeof candidate.nameZh === "string"
    && typeof candidate.rationale === "string"
    && typeof candidate.systemSupported === "boolean"
    && typeof candidate.hardConflict === "boolean";
}

function reusableResult(run: {
  status: string;
  structuredResult: unknown;
  provider: string;
  model: string;
  modelVersion: string | null;
  latencyMs: number | null;
  cost: number | null;
}): ChannelResult | null {
  if (run.status !== "completed" && run.status !== "reused") return null;
  const result = run.structuredResult as { candidates?: unknown } | null;
  if (!result || !Array.isArray(result.candidates) || !result.candidates.every(isCandidate)) return null;
  return {
    candidates: result.candidates,
    provider: run.provider,
    model: run.model,
    modelVersion: run.modelVersion ?? undefined,
    latencyMs: run.latencyMs ?? undefined,
    cost: run.cost ?? undefined,
  };
}

/**
 * Writes only structured, versioned recommendation evidence. In particular it
 * deliberately has no parameter for prompts, provider transcripts, signed URLs
 * or generated assets.
 */
export function createDualSourceRecommendationPersistence(prisma: PrismaClient) {
  return {
    /**
     * A worker retry keeps the computation key stable. Reuse only a completed
     * structured result whose immutable input/version references still match;
     * a failed or malformed peer is deliberately omitted for an independent
     * retry. No prompt, transcript, or signed URL is read or stored here.
     */
    async findReusableChannels(input: {
      planId: string;
      domain: RecommendationDomain;
      generation: number;
      computationKey: string;
      commonInput: CommonRecommendationInput;
      appearanceAnalysisRef?: string | null;
      questionnaireSnapshotRef?: string | null;
      recommendationContextRef?: string | null;
      catalogManifestVersion?: string | null;
      promptVersion: string;
      schemaVersion: string;
    }): Promise<Partial<Record<"A" | "B", ChannelResult>>> {
      const comparison = await prisma.recommendationComparisonLog.findUnique({
        where: {
          planId_domain_generation_computationKey: {
            planId: input.planId,
            domain: input.domain,
            generation: input.generation,
            computationKey: input.computationKey,
          },
        },
        include: { channelRuns: true },
      });
      if (!comparison
        || comparison.profileSnapshotRef !== input.commonInput.profileSnapshotRef
        || JSON.stringify(comparison.photoAssetRefs) !== JSON.stringify(input.commonInput.originalAssetRefs)
        || comparison.appearanceAnalysisRef !== (input.appearanceAnalysisRef ?? null)
        || comparison.questionnaireSnapshotRef !== (input.questionnaireSnapshotRef ?? null)
        || comparison.recommendationContextRef !== (input.recommendationContextRef ?? null)
        || comparison.catalogManifestVersion !== (input.catalogManifestVersion ?? null)) {
        return {};
      }
      const versions = comparison.inputVersions as {
        selectedUpstream?: unknown;
        model?: unknown;
        promptVersion?: unknown;
        schemaVersion?: unknown;
      };
      if (versions.promptVersion !== input.promptVersion
        || versions.schemaVersion !== input.schemaVersion
        || JSON.stringify(versions.selectedUpstream) !== JSON.stringify(input.commonInput.selectedUpstream)
        || JSON.stringify(versions.model) !== JSON.stringify(input.commonInput.model)) {
        return {};
      }
      const reusable: Partial<Record<"A" | "B", ChannelResult>> = {};
      for (const run of comparison.channelRuns) {
        const result = reusableResult(run);
        if (result) reusable[run.channel] = result;
      }
      return reusable;
    },

    async persist(input: {
      userId: string;
      planId: string;
      domain: RecommendationDomain;
      generation: number;
      computationKey: string;
      commonInput: CommonRecommendationInput;
      appearanceAnalysisRef?: string | null;
      questionnaireSnapshotRef?: string | null;
      recommendationContextRef?: string | null;
      catalogManifestVersion?: string | null;
      promptVersion: string;
      schemaVersion: string;
      /** Optional after RecommendationCandidate rows have been inserted. */
      candidateRecordIds?: Readonly<Record<string, string>>;
      recommendationSetId?: string | null;
      result: DualSourceResult;
    }) {
      return prisma.$transaction(async (tx) => {
        const comparison = await tx.recommendationComparisonLog.upsert({
          where: {
            planId_domain_generation_computationKey: {
              planId: input.planId,
              domain: input.domain,
              generation: input.generation,
              computationKey: input.computationKey,
            },
          },
          create: {
            userId: input.userId,
            planId: input.planId,
            recommendationSetId: input.recommendationSetId ?? null,
            domain: input.domain,
            generation: input.generation,
            computationKey: input.computationKey,
            profileSnapshotRef: input.commonInput.profileSnapshotRef,
            photoAssetRefs: input.commonInput.originalAssetRefs,
            appearanceAnalysisRef: input.appearanceAnalysisRef ?? null,
            questionnaireSnapshotRef: input.questionnaireSnapshotRef ?? null,
            recommendationContextRef: input.recommendationContextRef ?? null,
            catalogManifestVersion: input.catalogManifestVersion ?? null,
            inputVersions: {
              selectedUpstream: input.commonInput.selectedUpstream,
              model: input.commonInput.model,
              promptVersion: input.promptVersion,
              schemaVersion: input.schemaVersion,
            },
            retrievalAudit: input.result.audit.retrieval,
            diffResult: {
              ...input.result.audit.diff,
              invalidBIds: input.result.audit.invalidBIds,
              degradation: input.result.audit.degradation,
            },
            mergePolicyVersion: input.result.audit.diff.diffPolicyVersion,
            stochasticComparison: input.commonInput.model.supportsSeed !== true,
            reviewerStatus: input.result.audit.diff.severity === "high" ? "pending" : "not_required",
          },
          update: {
            recommendationSetId: input.recommendationSetId ?? undefined,
            retrievalAudit: input.result.audit.retrieval,
            diffResult: {
              ...input.result.audit.diff,
              invalidBIds: input.result.audit.invalidBIds,
              degradation: input.result.audit.degradation,
            },
            reviewerStatus: input.result.audit.diff.severity === "high" ? "pending" : "not_required",
          },
        });

        for (const channel of ["A", "B"] as const) {
          const audit = input.result.audit.channels[channel];
          await tx.recommendationChannelRun.upsert({
            where: { comparisonId_channel: { comparisonId: comparison.id, channel } },
            create: {
              comparisonId: comparison.id,
              channel,
              computationKey: `${input.computationKey}:${channel}`,
              status: channelStatus(audit),
              provider: audit.provider ?? input.commonInput.model.provider,
              model: audit.model ?? input.commonInput.model.model,
              modelVersion: audit.modelVersion ?? null,
              promptVersion: input.promptVersion,
              schemaVersion: input.schemaVersion,
              latencyMs: audit.latencyMs ?? null,
              cost: audit.cost ?? null,
              structuredResult: audit.status === "not_run" ? undefined : { candidates: audit.candidates },
              failureCode: audit.failureCode ?? (audit.status === "not_run" ? "catalog_unavailable" : null),
            },
            update: {
              status: channelStatus(audit),
              latencyMs: audit.latencyMs ?? null,
              cost: audit.cost ?? null,
              structuredResult: audit.status === "not_run" ? undefined : { candidates: audit.candidates },
              failureCode: audit.failureCode ?? (audit.status === "not_run" ? "catalog_unavailable" : null),
            },
          });
        }

        const exposed = [...input.result.main, ...input.result.exploration];
        for (const [index, candidate] of exposed.entries()) {
          await tx.recommendationExposure.upsert({
            where: { comparisonId_position: { comparisonId: comparison.id, position: index + 1 } },
            create: {
              comparisonId: comparison.id,
              candidateId: input.candidateRecordIds?.[candidate.canonicalId] ?? null,
              candidateSnapshot: candidate,
              source: candidate.source,
              position: index + 1,
            },
            update: {},
          });
        }

        // A-only concepts remain selectable as text, but their missing catalog
        // mapping and assets must become an explicit, deduplicated backlog.
        for (const candidate of exposed.filter((row) => row.source === "exploration" && row.canonicalId.startsWith("concept:"))) {
          const gap = await tx.catalogGap.upsert({
            where: { domain_conceptItemId: { domain: input.domain, conceptItemId: candidate.canonicalId } },
            create: {
              comparisonId: comparison.id,
              domain: input.domain,
              conceptItemId: candidate.canonicalId,
              reason: "catalog_external_exploration",
            },
            update: { comparisonId: comparison.id },
          });
          await tx.assetGenerationQueue.upsert({
            where: { gapId: gap.id },
            create: { gapId: gap.id, status: "queued", priority: 0 },
            update: {},
          });
        }

        if (input.result.audit.diff.severity === "high") {
          await tx.recommendationReviewerResult.upsert({
            where: { comparisonId: comparison.id },
            create: { comparisonId: comparison.id, status: "pending", relatedRuleIds: [] },
            update: { status: "pending" },
          });
        }
        return comparison;
      });
    },

    async recordChoice(input: { comparisonId: string; candidateId: string }) {
      const exposure = await prisma.recommendationExposure.findFirst({
        where: { comparisonId: input.comparisonId, candidateId: input.candidateId },
        orderBy: { position: "asc" },
      });
      if (!exposure) return null;
      const choice = await prisma.recommendationChoice.upsert({
        where: { comparisonId_exposureId: { comparisonId: input.comparisonId, exposureId: exposure.id } },
        create: { comparisonId: input.comparisonId, exposureId: exposure.id, candidateId: input.candidateId },
        update: {},
      });
      const snapshot = exposure.candidateSnapshot as { canonicalId?: unknown };
      if (typeof snapshot.canonicalId === "string" && snapshot.canonicalId.startsWith("concept:")) {
        const comparison = await prisma.recommendationComparisonLog.findUnique({
          where: { id: input.comparisonId },
          select: { domain: true },
        });
        if (comparison) {
          const gap = await prisma.catalogGap.findUnique({
            where: { domain_conceptItemId: { domain: comparison.domain, conceptItemId: snapshot.canonicalId } },
          });
          if (gap) {
            await prisma.$transaction([
              prisma.catalogGap.update({ where: { id: gap.id }, data: { selectionCount: { increment: 1 } } }),
              prisma.assetGenerationQueue.update({ where: { gapId: gap.id }, data: { priority: { increment: 1 } } }),
            ]);
          }
        }
      }
      return choice;
    },

    async recordCatalogGap(input: {
      planId: string;
      domain: string;
      generation: number;
      computationKey: string;
      conceptItemId: string;
      reason: string;
    }) {
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
      const gap = await prisma.catalogGap.upsert({
        where: { domain_conceptItemId: { domain: input.domain, conceptItemId: input.conceptItemId } },
        create: {
          comparisonId: comparison?.id ?? null,
          domain: input.domain,
          conceptItemId: input.conceptItemId,
          reason: input.reason,
        },
        update: { comparisonId: comparison?.id ?? undefined, reason: input.reason },
      });
      await prisma.assetGenerationQueue.upsert({
        where: { gapId: gap.id },
        create: { gapId: gap.id, status: "queued", priority: 0 },
        update: {},
      });
      return gap;
    },

    async recordOutcome(input: {
      comparisonId: string;
      exposureId?: string;
      outcomeType: "saved" | "slot_replaced" | "explicitly_disliked" | "try_on_saved" | "finally_adopted";
      payload?: Record<string, unknown>;
    }) {
      return prisma.recommendationOutcome.create({
        data: {
          comparisonId: input.comparisonId,
          exposureId: input.exposureId ?? null,
          outcomeType: input.outcomeType,
          payload: (input.payload ?? undefined) as never,
        },
      });
    },
  };
}
