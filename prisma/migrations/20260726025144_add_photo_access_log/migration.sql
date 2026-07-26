-- CreateTable
CREATE TABLE "PhotoAccessLog" (
    "id" TEXT NOT NULL,
    "photoId" TEXT,
    "storageKey" TEXT NOT NULL,
    "accessorType" TEXT NOT NULL,
    "accessorId" TEXT,
    "purpose" TEXT NOT NULL,
    "expiresInSeconds" INTEGER NOT NULL,
    "sourceIp" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PhotoAccessLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PhotoAccessLog_photoId_createdAt_idx" ON "PhotoAccessLog"("photoId", "createdAt");

-- CreateIndex
CREATE INDEX "PhotoAccessLog_accessorType_createdAt_idx" ON "PhotoAccessLog"("accessorType", "createdAt");
