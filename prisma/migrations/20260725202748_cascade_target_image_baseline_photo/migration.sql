-- DropForeignKey
ALTER TABLE "TargetImage" DROP CONSTRAINT "TargetImage_baselinePhotoId_fkey";

-- AddForeignKey
ALTER TABLE "TargetImage" ADD CONSTRAINT "TargetImage_baselinePhotoId_fkey" FOREIGN KEY ("baselinePhotoId") REFERENCES "UserPhoto"("id") ON DELETE CASCADE ON UPDATE CASCADE;
