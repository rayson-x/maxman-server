-- CreateEnum
CREATE TYPE "ConsentType" AS ENUM ('terms', 'face_processing', 'training');

-- CreateEnum
CREATE TYPE "Track" AS ENUM ('short_term', 'long_term');

-- CreateEnum
CREATE TYPE "BudgetTier" AS ENUM ('low', 'medium', 'high');

-- CreateEnum
CREATE TYPE "SelfReportedHairVolume" AS ENUM ('thin', 'medium', 'thick');

-- CreateEnum
CREATE TYPE "PhotoType" AS ENUM ('front', 'side', 'full_body', 'progress');

-- CreateEnum
CREATE TYPE "ModerationStatus" AS ENUM ('pending', 'passed', 'rejected');

-- CreateEnum
CREATE TYPE "DeletionStatus" AS ENUM ('active', 'pending', 'deleted');

-- CreateEnum
CREATE TYPE "HairVolumeRequirement" AS ENUM ('low', 'medium', 'high');

-- CreateEnum
CREATE TYPE "EvidenceBasis" AS ENUM ('visual_detected', 'self_reported', 'general_best_practice');

-- CreateEnum
CREATE TYPE "Reversibility" AS ENUM ('full', 'partial', 'irreversible');

-- CreateEnum
CREATE TYPE "RiskLevel" AS ENUM ('low', 'medium', 'high');

-- CreateEnum
CREATE TYPE "PlanStatus" AS ENUM ('active', 'completed', 'abandoned');

-- CreateEnum
CREATE TYPE "StageStatus" AS ENUM ('locked', 'active', 'completed');

-- CreateEnum
CREATE TYPE "TaskPriority" AS ENUM ('core', 'optional');

-- CreateEnum
CREATE TYPE "TaskType" AS ENUM ('simple', 'guided_selection');

-- CreateEnum
CREATE TYPE "SelectionStatus" AS ENUM ('not_applicable', 'pending_selection', 'selected');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('pending', 'done', 'skipped', 'blocked', 'replaced');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('unverified', 'verified', 'rolled_back');

-- CreateEnum
CREATE TYPE "TargetImageType" AS ENUM ('face_hair', 'full_body_outfit');

-- CreateEnum
CREATE TYPE "QualityCheckStatus" AS ENUM ('pending', 'passed', 'failed');

-- CreateEnum
CREATE TYPE "JobType" AS ENUM ('initial_analysis', 'outfit_preview_generation', 'plan_materialization', 'stage_unlock_generation', 'user_regeneration', 'progress_recheck');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('created', 'input_moderating', 'analyzing', 'recommending', 'rendering', 'materializing', 'output_moderating', 'quality_checking', 'completed', 'completed_partial', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "ProviderCallStatus" AS ENUM ('submitted', 'polling', 'done', 'failed');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "deviceSessionId" TEXT NOT NULL,
    "phone" TEXT,
    "birthDate" TIMESTAMP(3),
    "ageConfirmed18Plus" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsentRecord" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "consentType" "ConsentType" NOT NULL,
    "version" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "sourceIp" TEXT,
    "snapshotTextRef" TEXT,

    CONSTRAINT "ConsentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppearanceProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "heightCm" INTEGER,
    "weightKg" DOUBLE PRECISION,
    "shoulderWidthCm" DOUBLE PRECISION,
    "chestCm" DOUBLE PRECISION,
    "waistCm" DOUBLE PRECISION,
    "thighCm" DOUBLE PRECISION,
    "bodyFatPercent" DOUBLE PRECISION,
    "exercisesRegularly" BOOLEAN,
    "occupation" TEXT,
    "wearsGlasses" BOOLEAN,
    "hasBeard" BOOLEAN,
    "selfReportedHairVolume" "SelfReportedHairVolume",
    "hairLossConcern" BOOLEAN NOT NULL DEFAULT false,
    "domainSelections" TEXT[],
    "domainAcceptance" JSONB,
    "budgetTier" "BudgetTier",
    "confirmedFaceShape" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppearanceProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "eventType" TEXT,
    "eventDate" TIMESTAMP(3),
    "city" TEXT,
    "venueType" TEXT,
    "activityType" TEXT,
    "desiredImpression" TEXT,
    "formalityLevel" INTEGER,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserPhoto" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "photoType" "PhotoType" NOT NULL,
    "storageKey" TEXT NOT NULL,
    "faceMetrics" JSONB,
    "moderationStatus" "ModerationStatus" NOT NULL DEFAULT 'pending',
    "moderationReason" TEXT,
    "deletionStatus" "DeletionStatus" NOT NULL DEFAULT 'active',
    "trainingConsentId" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserPhoto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StyleProfileEntry" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "nameZh" TEXT NOT NULL,
    "aliases" TEXT[],
    "description" TEXT,
    "formality" INTEGER NOT NULL,
    "maturity" INTEGER NOT NULL,
    "boldness" INTEGER NOT NULL,
    "upkeep" INTEGER NOT NULL,
    "femaleAppealScore" INTEGER NOT NULL,
    "femaleAppealSource" TEXT NOT NULL,
    "femaleAppealConfidence" TEXT NOT NULL,
    "femaleAppealRationale" TEXT NOT NULL,
    "maleSelfAppealScore" INTEGER NOT NULL,
    "maleSelfAppealSource" TEXT NOT NULL,
    "maleSelfAppealConfidence" TEXT NOT NULL,
    "maleSelfAppealRationale" TEXT NOT NULL,
    "requiresHairVolume" "HairVolumeRequirement",
    "coversForehead" BOOLEAN,
    "suitableFaceShapes" TEXT[],
    "unsuitableFaceShapes" JSONB,
    "suitableBodyTypes" TEXT[],
    "suitableScenes" TEXT[],
    "items" JSONB,
    "estCostRange" TEXT,
    "estTime" TEXT,
    "notes" TEXT,
    "isRecommended" BOOLEAN NOT NULL DEFAULT true,
    "exclusionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StyleProfileEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StyleReferenceGuide" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "styleTag" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "referenceUrl" TEXT,
    "referenceType" TEXT,
    "summaryText" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StyleReferenceGuide_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidateTaskCatalog" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "methodName" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "evidenceBasis" "EvidenceBasis" NOT NULL,
    "estTime" TEXT,
    "estCostRange" TEXT,
    "reversibility" "Reversibility" NOT NULL,
    "riskLevel" "RiskLevel" NOT NULL,
    "riskNote" TEXT,
    "applicableStageRange" TEXT[],
    "visualBenefitLevel" TEXT,
    "isRecommended" BOOLEAN NOT NULL DEFAULT true,
    "exclusionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CandidateTaskCatalog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppearancePlan" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "eventId" TEXT,
    "track" "Track" NOT NULL,
    "currentStage" INTEGER NOT NULL DEFAULT 0,
    "status" "PlanStatus" NOT NULL DEFAULT 'active',
    "planVersion" INTEGER NOT NULL DEFAULT 1,
    "generationSeed" INTEGER NOT NULL,
    "selectedHairstyleId" TEXT,
    "selectedOutfitId" TEXT,
    "femaleAppealWeight" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppearancePlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Stage" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "stageIndex" INTEGER NOT NULL,
    "windowLabel" TEXT NOT NULL,
    "status" "StageStatus" NOT NULL DEFAULT 'locked',
    "unlockRule" JSONB NOT NULL,
    "completionPct" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Stage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StageTask" (
    "id" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "priority" "TaskPriority" NOT NULL,
    "evidenceBasis" "EvidenceBasis" NOT NULL,
    "taskType" "TaskType" NOT NULL DEFAULT 'simple',
    "selectionStatus" "SelectionStatus" NOT NULL DEFAULT 'not_applicable',
    "candidateOptions" JSONB,
    "styleTag" TEXT,
    "title" TEXT NOT NULL,
    "estTime" TEXT,
    "estCost" TEXT,
    "rationale" TEXT,
    "completionCriteria" TEXT,
    "alternative" TEXT,
    "expectedImpact" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'pending',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "changeDescription" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StageTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChangeManifestEntry" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "sourceTaskId" TEXT,
    "domain" TEXT NOT NULL,
    "changeDescription" TEXT NOT NULL,
    "methodSummary" TEXT,
    "verificationStatus" "VerificationStatus" NOT NULL DEFAULT 'unverified',
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChangeManifestEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TargetImage" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "imageType" "TargetImageType" NOT NULL,
    "baselinePhotoId" TEXT NOT NULL,
    "manifestSnapshot" JSONB NOT NULL,
    "plannedChangesSnapshot" JSONB NOT NULL,
    "storageKey" TEXT,
    "changeExplanation" JSONB,
    "qualityCheckStatus" "QualityCheckStatus" NOT NULL DEFAULT 'pending',
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "isFreeFirstGeneration" BOOLEAN NOT NULL DEFAULT true,
    "consumedWeeklyQuota" BOOLEAN NOT NULL DEFAULT false,
    "modelVersion" TEXT,
    "provider" TEXT,
    "providerCallId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TargetImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalysisJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "planId" TEXT,
    "stageId" TEXT,
    "jobType" "JobType" NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'created',
    "errorReason" TEXT,
    "partialResult" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AnalysisJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowRun" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "planId" TEXT,
    "stepName" TEXT NOT NULL,
    "planVersion" INTEGER,
    "artifactVersion" TEXT,
    "promptVersion" TEXT,
    "modelVersion" TEXT,
    "provider" TEXT,
    "latencyMs" INTEGER,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "cost" DOUBLE PRECISION,
    "safetyResult" JSONB,
    "qualityResult" JSONB,
    "finalStatus" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderCallLog" (
    "id" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "reqKey" TEXT NOT NULL,
    "purpose" TEXT,
    "status" "ProviderCallStatus" NOT NULL DEFAULT 'submitted',
    "requestSummary" JSONB,
    "resultUrls" TEXT[],
    "error" TEXT,
    "costEstimate" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderCallLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationDecision" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "decisionKind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Feedback" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "helpfulScore" INTEGER,
    "confidenceChange" INTEGER,
    "completedActions" JSONB,
    "comments" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_deviceSessionId_key" ON "User"("deviceSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");

-- CreateIndex
CREATE INDEX "User_deviceSessionId_idx" ON "User"("deviceSessionId");

-- CreateIndex
CREATE INDEX "ConsentRecord_userId_consentType_idx" ON "ConsentRecord"("userId", "consentType");

-- CreateIndex
CREATE UNIQUE INDEX "AppearanceProfile_userId_key" ON "AppearanceProfile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Event_userId_key" ON "Event"("userId");

-- CreateIndex
CREATE INDEX "UserPhoto_userId_photoType_idx" ON "UserPhoto"("userId", "photoType");

-- CreateIndex
CREATE INDEX "StyleProfileEntry_kind_isRecommended_idx" ON "StyleProfileEntry"("kind", "isRecommended");

-- CreateIndex
CREATE UNIQUE INDEX "StyleReferenceGuide_styleTag_key" ON "StyleReferenceGuide"("styleTag");

-- CreateIndex
CREATE INDEX "CandidateTaskCatalog_domain_isRecommended_idx" ON "CandidateTaskCatalog"("domain", "isRecommended");

-- CreateIndex
CREATE INDEX "AppearancePlan_userId_status_idx" ON "AppearancePlan"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Stage_planId_stageIndex_key" ON "Stage"("planId", "stageIndex");

-- CreateIndex
CREATE INDEX "StageTask_stageId_priority_status_idx" ON "StageTask"("stageId", "priority", "status");

-- CreateIndex
CREATE INDEX "ChangeManifestEntry_planId_stageId_idx" ON "ChangeManifestEntry"("planId", "stageId");

-- CreateIndex
CREATE INDEX "TargetImage_planId_stageId_imageType_idx" ON "TargetImage"("planId", "stageId", "imageType");

-- CreateIndex
CREATE INDEX "AnalysisJob_userId_status_idx" ON "AnalysisJob"("userId", "status");

-- CreateIndex
CREATE INDEX "AnalysisJob_planId_jobType_idx" ON "AnalysisJob"("planId", "jobType");

-- CreateIndex
CREATE INDEX "WorkflowRun_jobId_idx" ON "WorkflowRun"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderCallLog_callId_key" ON "ProviderCallLog"("callId");

-- CreateIndex
CREATE INDEX "ProviderCallLog_status_provider_idx" ON "ProviderCallLog"("status", "provider");

-- CreateIndex
CREATE INDEX "ConversationDecision_planId_decisionKind_idx" ON "ConversationDecision"("planId", "decisionKind");

-- AddForeignKey
ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppearanceProfile" ADD CONSTRAINT "AppearanceProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPhoto" ADD CONSTRAINT "UserPhoto_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppearancePlan" ADD CONSTRAINT "AppearancePlan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppearancePlan" ADD CONSTRAINT "AppearancePlan_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Stage" ADD CONSTRAINT "Stage_planId_fkey" FOREIGN KEY ("planId") REFERENCES "AppearancePlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StageTask" ADD CONSTRAINT "StageTask_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "Stage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeManifestEntry" ADD CONSTRAINT "ChangeManifestEntry_planId_fkey" FOREIGN KEY ("planId") REFERENCES "AppearancePlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeManifestEntry" ADD CONSTRAINT "ChangeManifestEntry_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "Stage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeManifestEntry" ADD CONSTRAINT "ChangeManifestEntry_sourceTaskId_fkey" FOREIGN KEY ("sourceTaskId") REFERENCES "StageTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TargetImage" ADD CONSTRAINT "TargetImage_planId_fkey" FOREIGN KEY ("planId") REFERENCES "AppearancePlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TargetImage" ADD CONSTRAINT "TargetImage_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "Stage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TargetImage" ADD CONSTRAINT "TargetImage_baselinePhotoId_fkey" FOREIGN KEY ("baselinePhotoId") REFERENCES "UserPhoto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisJob" ADD CONSTRAINT "AnalysisJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisJob" ADD CONSTRAINT "AnalysisJob_planId_fkey" FOREIGN KEY ("planId") REFERENCES "AppearancePlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "AnalysisJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_planId_fkey" FOREIGN KEY ("planId") REFERENCES "AppearancePlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationDecision" ADD CONSTRAINT "ConversationDecision_planId_fkey" FOREIGN KEY ("planId") REFERENCES "AppearancePlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_planId_fkey" FOREIGN KEY ("planId") REFERENCES "AppearancePlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
