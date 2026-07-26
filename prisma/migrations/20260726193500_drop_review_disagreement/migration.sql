/*
  Warnings:

  - You are about to drop the `ReviewDisagreement` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "ReviewDisagreement" DROP CONSTRAINT "ReviewDisagreement_jobId_fkey";

-- DropForeignKey
ALTER TABLE "ReviewDisagreement" DROP CONSTRAINT "ReviewDisagreement_planId_fkey";

-- DropTable
DROP TABLE "ReviewDisagreement";

-- DropEnum
DROP TYPE "ReviewDisagreementType";
