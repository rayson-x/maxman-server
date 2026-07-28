import assert from "node:assert/strict";
import test from "node:test";

import { createGeneratedAssetService } from "./generatedAssetService.js";

test("invalidated preview asset cannot be returned for a changed recommendation set", async () => {
  const rows: Array<Record<string, unknown>> = [];
  const prisma = {
    generatedAsset: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: "asset-1", status: "active", ...data };
        rows.push(row);
        return row;
      },
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        rows.find((row) => Object.entries(where).every(([key, value]) => row[key] === value)) ?? null,
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        let count = 0;
        for (const row of rows) {
          const setIds = (where.recommendationSetId as { in?: string[] } | undefined)?.in;
          if (!setIds || !setIds.includes(row.recommendationSetId as string)) continue;
          Object.assign(row, data);
          count += 1;
        }
        return { count };
      },
    },
  };
  const assets = createGeneratedAssetService(prisma as never);
  const asset = await assets.record({
    userId: "user-1",
    planId: "plan-1",
    candidateId: "outfit-1",
    kind: "outfit_preview",
    storageKey: "generated/outfit-1.png",
    provider: "ark",
    providerCallId: "call-1",
    modelVersion: "seedream-4.5",
    recommendationSetId: "outfit-set-1",
    styleDirectionId: "clean-fit",
    hairstyleCandidateId: "hair-1",
    outfitCandidateId: "outfit-1",
    baselinePhotoId: "photo-1",
    renderSpecVersion: "2026-07-28",
  } as never);

  const previewAssets = assets as unknown as {
    findActiveById: (id: string) => Promise<{ id: string } | null>;
    invalidateForRecommendationSets: (setIds: string[]) => Promise<void>;
  };
  assert.equal((await previewAssets.findActiveById(asset.assetId))?.id, "asset-1");
  await previewAssets.invalidateForRecommendationSets(["outfit-set-1"]);
  assert.equal(await previewAssets.findActiveById(asset.assetId), null);
});
