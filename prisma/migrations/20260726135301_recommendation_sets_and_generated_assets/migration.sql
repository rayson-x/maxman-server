-- CreateEnum
CREATE TYPE "RecommendationKind" AS ENUM ('hairstyle', 'outfit');

-- CreateEnum
CREATE TYPE "RecommendationSetStatus" AS ENUM ('preparing', 'ready', 'failed', 'superseded');

-- CreateEnum
CREATE TYPE "CandidateVerificationStatus" AS ENUM ('agent_estimated', 'catalog_verified', 'not_checked');

-- CreateEnum
CREATE TYPE "GeneratedAssetKind" AS ENUM ('hairstyle_preview', 'outfit_preview', 'target_image');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ProviderCallStatus" ADD VALUE 'prepared';
ALTER TYPE "ProviderCallStatus" ADD VALUE 'unknown';

-- CreateTable
CREATE TABLE "RecommendationSet" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "kind" "RecommendationKind" NOT NULL,
    "status" "RecommendationSetStatus" NOT NULL DEFAULT 'preparing',
    "computationKey" TEXT NOT NULL,
    "inputFingerprint" TEXT NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "source" TEXT NOT NULL,
    "capabilityStatus" JSONB NOT NULL,
    "injectedContext" JSONB,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecommendationSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecommendationCandidate" (
    "id" TEXT NOT NULL,
    "setId" TEXT NOT NULL,
    "catalogVariantId" TEXT,
    "providerCandidateKey" TEXT NOT NULL,
    "nameZh" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "modelRationale" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "visualDirection" TEXT NOT NULL,
    "renderInstruction" TEXT NOT NULL,
    "estimatedAttributes" JSONB,
    "verificationStatus" "CandidateVerificationStatus" NOT NULL DEFAULT 'not_checked',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecommendationCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GeneratedAsset" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "planId" TEXT,
    "candidateId" TEXT,
    "kind" "GeneratedAssetKind" NOT NULL,
    "storageKey" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerCallId" TEXT,
    "disclosure" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GeneratedAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RecommendationSet_computationKey_key" ON "RecommendationSet"("computationKey");

-- CreateIndex
CREATE INDEX "RecommendationSet_planId_kind_status_idx" ON "RecommendationSet"("planId", "kind", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RecommendationCandidate_setId_rank_key" ON "RecommendationCandidate"("setId", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "RecommendationCandidate_setId_providerCandidateKey_key" ON "RecommendationCandidate"("setId", "providerCandidateKey");

-- CreateIndex
CREATE INDEX "GeneratedAsset_userId_kind_idx" ON "GeneratedAsset"("userId", "kind");

-- CreateIndex
CREATE INDEX "GeneratedAsset_planId_idx" ON "GeneratedAsset"("planId");

-- AddForeignKey
ALTER TABLE "RecommendationSet" ADD CONSTRAINT "RecommendationSet_planId_fkey" FOREIGN KEY ("planId") REFERENCES "AppearancePlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecommendationCandidate" ADD CONSTRAINT "RecommendationCandidate_setId_fkey" FOREIGN KEY ("setId") REFERENCES "RecommendationSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GeneratedAsset" ADD CONSTRAINT "GeneratedAsset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GeneratedAsset" ADD CONSTRAINT "GeneratedAsset_planId_fkey" FOREIGN KEY ("planId") REFERENCES "AppearancePlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GeneratedAsset" ADD CONSTRAINT "GeneratedAsset_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "RecommendationCandidate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
