-- CreateEnum
CREATE TYPE "ChangeWillingness" AS ENUM ('satisfied', 'average', 'unsatisfied', 'distressed');

-- AlterTable
ALTER TABLE "AppearanceProfile" ADD COLUMN     "changeWillingness" "ChangeWillingness";
