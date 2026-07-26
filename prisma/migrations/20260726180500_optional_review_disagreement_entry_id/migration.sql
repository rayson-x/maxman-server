-- Measurement disagreements and catalog-omission findings may not correspond
-- to an existing candidate entry. NULL represents that absence without a
-- fabricated sentinel identifier.
ALTER TABLE "ReviewDisagreement"
ALTER COLUMN "entryId" DROP NOT NULL;
