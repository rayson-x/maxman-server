-- LLM recommendations cannot honestly provide catalog vectors or appeal scores.
ALTER TABLE "StyleProfileEntry"
  ALTER COLUMN "formality" DROP NOT NULL,
  ALTER COLUMN "maturity" DROP NOT NULL,
  ALTER COLUMN "boldness" DROP NOT NULL,
  ALTER COLUMN "upkeep" DROP NOT NULL,
  ALTER COLUMN "femaleAppealScore" DROP NOT NULL,
  ALTER COLUMN "maleSelfAppealScore" DROP NOT NULL;

CREATE TYPE "StyleEntrySource" AS ENUM ('catalog', 'vision_llm_generated');

ALTER TABLE "StyleProfileEntry"
  ADD COLUMN "source" "StyleEntrySource" NOT NULL DEFAULT 'catalog',
  ADD COLUMN "generatedForPlanId" TEXT;

CREATE INDEX "StyleProfileEntry_generatedForPlanId_idx"
  ON "StyleProfileEntry"("generatedForPlanId");

ALTER TABLE "StyleProfileEntry"
  ADD CONSTRAINT "StyleProfileEntry_generatedForPlanId_fkey"
  FOREIGN KEY ("generatedForPlanId") REFERENCES "AppearancePlan"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
