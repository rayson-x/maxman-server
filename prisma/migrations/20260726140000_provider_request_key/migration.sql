-- providerRequestKey：我们在提交供应商**之前**生成的请求键。
-- prepared 记录靠它定位——供应商的 task_id 要提交成功才知道，
-- 而崩溃窗口恰好在那之前。
ALTER TABLE "ProviderCallLog" ADD COLUMN "providerRequestKey" TEXT;

-- callId 改为可空：prepared 阶段还没有它。
ALTER TABLE "ProviderCallLog" ALTER COLUMN "callId" DROP NOT NULL;

-- 现存行的 providerRequestKey 全为 NULL，Postgres 的唯一约束允许多个 NULL
CREATE UNIQUE INDEX "ProviderCallLog_providerRequestKey_key" ON "ProviderCallLog"("providerRequestKey");
