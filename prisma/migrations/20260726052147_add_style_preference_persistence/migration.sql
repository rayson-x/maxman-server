-- AlterTable
ALTER TABLE "AppearanceProfile" ADD COLUMN     "stylePreferenceStyleTag" TEXT,
ADD COLUMN     "stylePreferenceText" TEXT,
ADD COLUMN     "stylePreferenceUserSpecified" BOOLEAN NOT NULL DEFAULT false;
