ALTER TABLE "AnalysisJob" ADD COLUMN "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "AnalysisJob_userId_jobType_idempotencyKey_key"
  ON "AnalysisJob"("userId", "jobType", "idempotencyKey");
