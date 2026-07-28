-- Structured dual-source recommendation audit. No raw prompts, transcripts,
-- signed URLs, or photo bytes are persisted in these tables.

CREATE TYPE "RecommendationChannel" AS ENUM ('A', 'B');
CREATE TYPE "RecommendationChannelRunStatus" AS ENUM ('pending', 'completed', 'failed', 'timed_out', 'reused');
CREATE TYPE "RecommendationReviewerStatus" AS ENUM ('not_required', 'pending', 'completed', 'failed');
CREATE TYPE "RecommendationReviewerClassification" AS ENUM ('agree', 'rule_gap', 'rule_conflict', 'rule_misapplied', 'llm_hallucination');
CREATE TYPE "RecommendationOutcomeType" AS ENUM ('saved', 'slot_replaced', 'explicitly_disliked', 'try_on_saved', 'finally_adopted');

CREATE TABLE "RecommendationComparisonLog" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "planId" TEXT NOT NULL,
  "recommendationSetId" TEXT,
  "domain" TEXT NOT NULL,
  "generation" INTEGER NOT NULL,
  "computationKey" TEXT NOT NULL,
  "profileSnapshotRef" TEXT NOT NULL,
  "photoAssetRefs" TEXT[] NOT NULL,
  "appearanceAnalysisRef" TEXT,
  "questionnaireSnapshotRef" TEXT,
  "recommendationContextRef" TEXT,
  "catalogManifestVersion" TEXT,
  "inputVersions" JSONB NOT NULL,
  "retrievalAudit" JSONB NOT NULL,
  "diffResult" JSONB NOT NULL,
  "mergePolicyVersion" TEXT NOT NULL,
  "stochasticComparison" BOOLEAN NOT NULL DEFAULT false,
  "reviewerStatus" "RecommendationReviewerStatus" NOT NULL DEFAULT 'not_required',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RecommendationComparisonLog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RecommendationChannelRun" (
  "id" TEXT NOT NULL,
  "comparisonId" TEXT NOT NULL,
  "channel" "RecommendationChannel" NOT NULL,
  "computationKey" TEXT NOT NULL,
  "status" "RecommendationChannelRunStatus" NOT NULL DEFAULT 'pending',
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "modelVersion" TEXT,
  "promptVersion" TEXT NOT NULL,
  "schemaVersion" TEXT NOT NULL,
  "latencyMs" INTEGER,
  "cost" DOUBLE PRECISION,
  "retryCount" INTEGER NOT NULL DEFAULT 0,
  "reused" BOOLEAN NOT NULL DEFAULT false,
  "structuredResult" JSONB,
  "failureCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RecommendationChannelRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RecommendationExposure" (
  "id" TEXT NOT NULL,
  "comparisonId" TEXT NOT NULL,
  "candidateId" TEXT,
  "candidateSnapshot" JSONB NOT NULL,
  "source" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "exposedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RecommendationExposure_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RecommendationChoice" (
  "id" TEXT NOT NULL,
  "comparisonId" TEXT NOT NULL,
  "exposureId" TEXT NOT NULL,
  "candidateId" TEXT,
  "evidenceKind" TEXT NOT NULL DEFAULT 'behavioral_evidence',
  "chosenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RecommendationChoice_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RecommendationOutcome" (
  "id" TEXT NOT NULL,
  "comparisonId" TEXT NOT NULL,
  "exposureId" TEXT,
  "outcomeType" "RecommendationOutcomeType" NOT NULL,
  "payload" JSONB,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RecommendationOutcome_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RecommendationReviewerResult" (
  "id" TEXT NOT NULL,
  "comparisonId" TEXT NOT NULL,
  "status" "RecommendationReviewerStatus" NOT NULL DEFAULT 'pending',
  "classification" "RecommendationReviewerClassification",
  "relatedRuleIds" TEXT[] NOT NULL,
  "notes" TEXT,
  "suggestion" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "RecommendationReviewerResult_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CatalogGap" (
  "id" TEXT NOT NULL,
  "comparisonId" TEXT,
  "domain" TEXT NOT NULL,
  "conceptItemId" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "selectionCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CatalogGap_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AssetGenerationQueue" (
  "id" TEXT NOT NULL,
  "gapId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "priority" INTEGER NOT NULL DEFAULT 0,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AssetGenerationQueue_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ConceptCatalogMapping" (
  "id" TEXT NOT NULL,
  "domain" TEXT NOT NULL,
  "conceptItemId" TEXT NOT NULL,
  "catalogItemId" TEXT NOT NULL,
  "assetStatus" TEXT NOT NULL,
  "reviewedBy" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ConceptCatalogMapping_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RecommendationComparisonLog_recommendationSetId_key" ON "RecommendationComparisonLog"("recommendationSetId");
CREATE UNIQUE INDEX "RecommendationComparisonLog_planId_domain_generation_computationKey_key" ON "RecommendationComparisonLog"("planId", "domain", "generation", "computationKey");
CREATE INDEX "RecommendationComparisonLog_userId_domain_createdAt_idx" ON "RecommendationComparisonLog"("userId", "domain", "createdAt");
CREATE UNIQUE INDEX "RecommendationChannelRun_comparisonId_channel_key" ON "RecommendationChannelRun"("comparisonId", "channel");
CREATE UNIQUE INDEX "RecommendationChannelRun_computationKey_key" ON "RecommendationChannelRun"("computationKey");
CREATE INDEX "RecommendationChannelRun_status_updatedAt_idx" ON "RecommendationChannelRun"("status", "updatedAt");
CREATE UNIQUE INDEX "RecommendationExposure_comparisonId_position_key" ON "RecommendationExposure"("comparisonId", "position");
CREATE INDEX "RecommendationExposure_comparisonId_source_idx" ON "RecommendationExposure"("comparisonId", "source");
CREATE UNIQUE INDEX "RecommendationChoice_comparisonId_exposureId_key" ON "RecommendationChoice"("comparisonId", "exposureId");
CREATE INDEX "RecommendationChoice_comparisonId_chosenAt_idx" ON "RecommendationChoice"("comparisonId", "chosenAt");
CREATE INDEX "RecommendationOutcome_comparisonId_outcomeType_idx" ON "RecommendationOutcome"("comparisonId", "outcomeType");
CREATE UNIQUE INDEX "RecommendationReviewerResult_comparisonId_key" ON "RecommendationReviewerResult"("comparisonId");
CREATE UNIQUE INDEX "CatalogGap_domain_conceptItemId_key" ON "CatalogGap"("domain", "conceptItemId");
CREATE INDEX "CatalogGap_status_updatedAt_idx" ON "CatalogGap"("status", "updatedAt");
CREATE UNIQUE INDEX "AssetGenerationQueue_gapId_key" ON "AssetGenerationQueue"("gapId");
CREATE INDEX "AssetGenerationQueue_status_priority_idx" ON "AssetGenerationQueue"("status", "priority");
CREATE UNIQUE INDEX "ConceptCatalogMapping_domain_conceptItemId_key" ON "ConceptCatalogMapping"("domain", "conceptItemId");
CREATE INDEX "ConceptCatalogMapping_catalogItemId_idx" ON "ConceptCatalogMapping"("catalogItemId");

ALTER TABLE "RecommendationComparisonLog" ADD CONSTRAINT "RecommendationComparisonLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecommendationComparisonLog" ADD CONSTRAINT "RecommendationComparisonLog_planId_fkey" FOREIGN KEY ("planId") REFERENCES "AppearancePlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecommendationComparisonLog" ADD CONSTRAINT "RecommendationComparisonLog_recommendationSetId_fkey" FOREIGN KEY ("recommendationSetId") REFERENCES "RecommendationSet"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RecommendationChannelRun" ADD CONSTRAINT "RecommendationChannelRun_comparisonId_fkey" FOREIGN KEY ("comparisonId") REFERENCES "RecommendationComparisonLog"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecommendationExposure" ADD CONSTRAINT "RecommendationExposure_comparisonId_fkey" FOREIGN KEY ("comparisonId") REFERENCES "RecommendationComparisonLog"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecommendationChoice" ADD CONSTRAINT "RecommendationChoice_comparisonId_fkey" FOREIGN KEY ("comparisonId") REFERENCES "RecommendationComparisonLog"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecommendationChoice" ADD CONSTRAINT "RecommendationChoice_exposureId_fkey" FOREIGN KEY ("exposureId") REFERENCES "RecommendationExposure"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecommendationOutcome" ADD CONSTRAINT "RecommendationOutcome_comparisonId_fkey" FOREIGN KEY ("comparisonId") REFERENCES "RecommendationComparisonLog"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecommendationOutcome" ADD CONSTRAINT "RecommendationOutcome_exposureId_fkey" FOREIGN KEY ("exposureId") REFERENCES "RecommendationExposure"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RecommendationReviewerResult" ADD CONSTRAINT "RecommendationReviewerResult_comparisonId_fkey" FOREIGN KEY ("comparisonId") REFERENCES "RecommendationComparisonLog"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CatalogGap" ADD CONSTRAINT "CatalogGap_comparisonId_fkey" FOREIGN KEY ("comparisonId") REFERENCES "RecommendationComparisonLog"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AssetGenerationQueue" ADD CONSTRAINT "AssetGenerationQueue_gapId_fkey" FOREIGN KEY ("gapId") REFERENCES "CatalogGap"("id") ON DELETE CASCADE ON UPDATE CASCADE;
