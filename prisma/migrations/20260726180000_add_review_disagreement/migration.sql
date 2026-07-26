-- ReviewDisagreement records structured disagreements between the mainline
-- conclusion and the adversarial Agent review. It intentionally does not store
-- raw prompts or conversation text.
CREATE TYPE "ReviewDisagreementType" AS ENUM (
    'A_MEASUREMENT',
    'B_RANKING',
    'C_OMISSION',
    'D_SAFETY'
);

CREATE TABLE "ReviewDisagreement" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "type" "ReviewDisagreementType" NOT NULL,
    "entryId" TEXT NOT NULL,
    "agentClaim" TEXT NOT NULL,
    "mainlineConclusion" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "outcomeFact" TEXT,
    "outcomeAt" TIMESTAMP(3),

    CONSTRAINT "ReviewDisagreement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReviewDisagreement_idempotencyKey_key"
ON "ReviewDisagreement"("idempotencyKey");

CREATE INDEX "ReviewDisagreement_planId_createdAt_idx"
ON "ReviewDisagreement"("planId", "createdAt");

CREATE INDEX "ReviewDisagreement_jobId_idx"
ON "ReviewDisagreement"("jobId");

CREATE INDEX "ReviewDisagreement_type_entryId_idx"
ON "ReviewDisagreement"("type", "entryId");

ALTER TABLE "ReviewDisagreement"
ADD CONSTRAINT "ReviewDisagreement_planId_fkey"
FOREIGN KEY ("planId") REFERENCES "AppearancePlan"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ReviewDisagreement"
ADD CONSTRAINT "ReviewDisagreement_jobId_fkey"
FOREIGN KEY ("jobId") REFERENCES "AnalysisJob"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
