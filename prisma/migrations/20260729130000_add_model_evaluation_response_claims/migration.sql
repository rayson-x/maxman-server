-- Response rows, rather than transient queue jobs, own the atomic provider-call
-- claim and bounded attempt count. This prevents duplicate model calls across
-- worker processes and makes terminal outcomes durable.
ALTER TABLE "ModelEvaluationResponse"
  ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "claimToken" TEXT,
  ADD COLUMN "claimedAt" TIMESTAMP(3);

CREATE INDEX "ModelEvaluationResponse_status_attemptCount_idx"
  ON "ModelEvaluationResponse"("status", "attemptCount");
