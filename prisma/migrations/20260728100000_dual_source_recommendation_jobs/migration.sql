-- The three-stage dual-source flow waits for explicit style and hairstyle
-- choices. These jobs are independent of preview generation so a failed image
-- operation cannot erase a successfully persisted recommendation stage.
ALTER TYPE "JobType" ADD VALUE IF NOT EXISTS 'hairstyle_recommendation';
ALTER TYPE "JobType" ADD VALUE IF NOT EXISTS 'wardrobe_recommendation';
