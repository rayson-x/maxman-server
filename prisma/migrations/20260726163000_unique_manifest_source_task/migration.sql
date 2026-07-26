-- StageTask 的 done 请求允许网络重放；同一来源任务只能对应一条事实账本。
-- PostgreSQL unique index 允许多个 NULL，因此不影响人工/迁移产生的无 sourceTaskId 记录。
CREATE UNIQUE INDEX "ChangeManifestEntry_sourceTaskId_key"
ON "ChangeManifestEntry"("sourceTaskId");
