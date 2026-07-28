import type { PrismaClient } from "../../generated/prisma/client.js";
import type { AssembledCandidate, RecommendationDomain } from "./engine.js";

export type StoredDualSourceCandidates = {
  recommendationSetId: string;
  candidateRecordIds: Record<string, string>;
};

/**
 * Translates a completed dual-source result into the existing stable candidate
 * records. Style remains an immutable comparison/exposure snapshot because the
 * legacy RecommendationSet enum has no style member; hairstyle and wardrobe
 * selections always point at persisted candidate IDs.
 */
export function createDualSourceCandidateStore(prisma: PrismaClient) {
  return {
    async store(input: {
      planId: string;
      domain: Exclude<RecommendationDomain, "style">;
      generation: number;
      computationKey: string;
      candidates: AssembledCandidate[];
      /** A hairstyle candidate must stay scoped to the persisted style. */
      selectedStyleId?: string;
    }): Promise<StoredDualSourceCandidates> {
      const kind = input.domain === "hairstyle" ? "hairstyle" : "outfit";
      const setKey = `dual-source:${input.domain}:${input.computationKey}`;
      return prisma.$transaction(async (tx) => {
        // A reviewed mapping affects only newly stored candidates. Existing
        // comparison/exposure JSON remains the historical concept snapshot.
        const conceptIds = input.candidates
          .map((candidate) => candidate.canonicalId)
          .filter((canonicalId) => canonicalId.startsWith("concept:"));
        const mappings = conceptIds.length > 0
          ? await tx.conceptCatalogMapping.findMany({
              where: { domain: input.domain, conceptItemId: { in: conceptIds } },
              select: { conceptItemId: true, catalogItemId: true },
            })
          : [];
        const mappingByConcept = new Map(mappings.map((mapping) => [mapping.conceptItemId, mapping.catalogItemId]));
        const resolved = input.candidates.map((candidate) => {
          const catalogItemId = mappingByConcept.get(candidate.canonicalId);
          return {
            originalCanonicalId: candidate.canonicalId,
            candidate: catalogItemId
              ? { ...candidate, id: catalogItemId, canonicalId: catalogItemId }
              : candidate,
          };
        });
        const existing = await tx.recommendationSet.findUnique({
          where: { computationKey: setKey },
          include: { candidates: { orderBy: { rank: "asc" } } },
        });
        if (existing) {
          if (existing.planId !== input.planId || existing.kind !== kind) {
            throw new Error("dual_source_computation_key_conflict");
          }
          const existingByKey = new Map(existing.candidates.map((row) => [row.providerCandidateKey, row.id]));
          return {
            recommendationSetId: existing.id,
            candidateRecordIds: Object.fromEntries(
              resolved.flatMap(({ originalCanonicalId, candidate }) => {
                const candidateId = existingByKey.get(candidate.canonicalId);
                return candidateId ? [[originalCanonicalId, candidateId]] : [];
              }),
            ),
          };
        }
        const set = await tx.recommendationSet.create({
          data: {
            planId: input.planId,
            kind,
            status: "preparing",
            computationKey: setKey,
            inputFingerprint: input.computationKey,
            generation: input.generation,
            source: "hybrid",
            // Do not overclaim catalog verification merely because a candidate
            // appeared in B. The readiness projection governs that separately.
            capabilityStatus: {
              knowledgeSource: "hybrid",
              feasibility: "not_checked",
              outfitCoordination: "not_checked",
              previewQuality: "not_checked",
            },
          },
        });
        const rows = [...resolved].sort((a, b) => a.candidate.rank - b.candidate.rank || a.candidate.canonicalId.localeCompare(b.candidate.canonicalId));
        const created = await Promise.all(rows.map(({ candidate }, index) =>
          tx.recommendationCandidate.create({
            data: {
              setId: set.id,
              catalogVariantId: candidate.canonicalId.startsWith("concept:") ? null : candidate.canonicalId,
              providerCandidateKey: candidate.canonicalId,
              nameZh: candidate.nameZh,
              description: candidate.rationale,
              modelRationale: candidate.rationale,
              rank: index + 1,
              visualDirection: candidate.nameZh,
              // Rendering is deliberately disabled here. A later renderer must
              // resolve the exact provider/model calibration from the immutable
              // snapshot; text recommendation is still valid without it.
              renderInstruction: "",
              styleDirectionId: input.domain === "hairstyle" ? input.selectedStyleId ?? null : null,
              verificationStatus: "not_checked",
            },
          }),
        ));
        await tx.recommendationSet.update({ where: { id: set.id }, data: { status: "ready" } });
        return {
          recommendationSetId: set.id,
          candidateRecordIds: Object.fromEntries(created.map((row, index) => [rows[index]!.originalCanonicalId, row.id])),
        };
      });
    },
  };
}
