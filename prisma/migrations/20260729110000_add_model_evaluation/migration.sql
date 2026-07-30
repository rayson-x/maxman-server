-- One fixed public vision-model comparison run, its 20×5 response matrix, and
-- anonymous visitor ratings. No user photos or arbitrary paths are persisted.
CREATE TABLE "ModelEvaluationRun" (
    "id" TEXT NOT NULL,
    "runKey" TEXT NOT NULL,
    "manifestVersion" TEXT NOT NULL,
    "sampleManifest" JSONB NOT NULL,
    "modelDescriptors" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ModelEvaluationRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ModelEvaluationResponse" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "sampleId" TEXT NOT NULL,
    "samplePath" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "rawResponse" TEXT,
    "structuredResponse" JSONB,
    "latencyMs" INTEGER,
    "providerUsage" JSONB,
    "providerCallId" TEXT,
    "failureDetail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelEvaluationResponse_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ModelEvaluationRating" (
    "id" TEXT NOT NULL,
    "responseId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "hairstyleRecognitionScore" INTEGER NOT NULL,
    "foreheadCoverageScore" INTEGER NOT NULL,
    "recommendationUsefulnessScore" INTEGER NOT NULL,
    "hasUnsafeConclusion" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelEvaluationRating_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ModelEvaluationRun_runKey_key" ON "ModelEvaluationRun"("runKey");
CREATE INDEX "ModelEvaluationRun_status_idx" ON "ModelEvaluationRun"("status");
CREATE UNIQUE INDEX "ModelEvaluationResponse_runId_sampleId_modelId_key" ON "ModelEvaluationResponse"("runId", "sampleId", "modelId");
CREATE INDEX "ModelEvaluationResponse_runId_status_idx" ON "ModelEvaluationResponse"("runId", "status");
CREATE UNIQUE INDEX "ModelEvaluationRating_responseId_userId_key" ON "ModelEvaluationRating"("responseId", "userId");
CREATE INDEX "ModelEvaluationRating_userId_idx" ON "ModelEvaluationRating"("userId");

ALTER TABLE "ModelEvaluationResponse" ADD CONSTRAINT "ModelEvaluationResponse_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "ModelEvaluationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ModelEvaluationRating" ADD CONSTRAINT "ModelEvaluationRating_responseId_fkey"
  FOREIGN KEY ("responseId") REFERENCES "ModelEvaluationResponse"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ModelEvaluationRating" ADD CONSTRAINT "ModelEvaluationRating_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
