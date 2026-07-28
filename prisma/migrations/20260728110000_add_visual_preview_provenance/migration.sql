-- Preview images are optional derivatives of a recommendation set. Keep their
-- provenance and invalidate them on upstream selection changes instead of
-- deleting the audit record or allowing stale reads.
ALTER TYPE "JobType" ADD VALUE IF NOT EXISTS 'hairstyle_preview_generation';

CREATE TYPE "GeneratedAssetStatus" AS ENUM ('active', 'invalidated');

ALTER TABLE "GeneratedAsset"
  ADD COLUMN "recommendationSetId" TEXT,
  ADD COLUMN "styleDirectionId" TEXT,
  ADD COLUMN "hairstyleCandidateId" TEXT,
  ADD COLUMN "outfitCandidateId" TEXT,
  ADD COLUMN "baselinePhotoId" TEXT,
  ADD COLUMN "status" "GeneratedAssetStatus" NOT NULL DEFAULT 'active',
  ADD COLUMN "modelVersion" TEXT,
  ADD COLUMN "renderSpecVersion" TEXT;

CREATE INDEX "GeneratedAsset_planId_status_idx" ON "GeneratedAsset"("planId", "status");
CREATE INDEX "GeneratedAsset_recommendationSetId_status_idx" ON "GeneratedAsset"("recommendationSetId", "status");
