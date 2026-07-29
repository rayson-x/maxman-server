CREATE TABLE "ProviderPricingRule" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "model" TEXT NOT NULL DEFAULT '*',
  "version" INTEGER NOT NULL,
  "costState" TEXT NOT NULL DEFAULT 'known',
  "currency" TEXT,
  "unitPrices" JSONB NOT NULL,
  "effectiveAt" TIMESTAMP(3) NOT NULL,
  "checkedAt" TIMESTAMP(3) NOT NULL,
  "sourceUrl" TEXT,
  "sourceScope" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderPricingRule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProviderOperationUsage" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "model" TEXT,
  "status" TEXT NOT NULL,
  "providerCallId" TEXT,
  "pricingRuleId" TEXT,
  "pricingRuleVersion" INTEGER,
  "costState" TEXT NOT NULL,
  "estimatedCost" DOUBLE PRECISION,
  "currency" TEXT,
  "usage" JSONB NOT NULL,
  "sourceUsage" JSONB,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "ProviderOperationUsage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProviderPricingRule_provider_operation_model_version_key" ON "ProviderPricingRule"("provider", "operation", "model", "version");
CREATE INDEX "ProviderPricingRule_provider_operation_model_effectiveAt_idx" ON "ProviderPricingRule"("provider", "operation", "model", "effectiveAt");
CREATE UNIQUE INDEX "ProviderOperationUsage_provider_providerCallId_key" ON "ProviderOperationUsage"("provider", "providerCallId");
CREATE INDEX "ProviderOperationUsage_occurredAt_provider_operation_idx" ON "ProviderOperationUsage"("occurredAt", "provider", "operation");
CREATE INDEX "ProviderOperationUsage_provider_model_occurredAt_idx" ON "ProviderOperationUsage"("provider", "model", "occurredAt");
ALTER TABLE "ProviderOperationUsage" ADD CONSTRAINT "ProviderOperationUsage_pricingRuleId_fkey" FOREIGN KEY ("pricingRuleId") REFERENCES "ProviderPricingRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "ProviderPricingRule" ("id", "provider", "operation", "model", "version", "costState", "currency", "unitPrices", "effectiveAt", "checkedAt", "sourceUrl", "sourceScope") VALUES
  ('pricing-volc-dressing-v1', 'volcengine', 'clothing_swap', 'dressing_diffusion', 1, 'known', 'CNY', '{"acceptedTask": 1}', '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z', 'https://www.volcengine.com/docs/85128/1462742', 'public-list-price'),
  ('pricing-volc-seededit-v1', 'volcengine', 'image_edit', 'seededit_v3.0', 1, 'unknown', 'CNY', '{}', '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z', 'https://api.volcengine.com/api-docs/view?action=SeededitV30SubmitTask&serviceCode=cv&version=2024-06-06', 'price-unverified'),
  ('pricing-ark-seedream-v1', 'ark', 'image_edit', 'doubao-seedream-4-5-251128', 1, 'known', 'CNY', '{"generatedImage": 0.25}', '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z', 'https://www.volcengine.com/product/doubao', 'public-list-price'),
  ('pricing-qwen-image-edit-v1', 'qwen', 'image_edit', 'qwen-image-edit-plus', 1, 'known', 'CNY', '{"generatedImage": 0.2}', '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z', 'https://help.aliyun.com/zh/model-studio/qwen-image-edit-plus', 'public-list-price-beijing'),
  ('pricing-stepfun-image-edit-v1', 'stepfun', 'image_edit', 'step-image-edit-2', 1, 'known', 'CNY', '{"generatedImage": 0.02}', '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z', 'https://platform.stepfun.com/docs/zh/guides/pricing/details', 'public-list-price'),
  ('pricing-deepseek-v4-flash-v1', 'deepseek', '*', 'deepseek-v4-flash', 1, 'known', 'USD', '{"cacheHitInputToken": 0.0000000028, "cacheMissInputToken": 0.00000014, "outputToken": 0.00000028}', '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z', 'https://api-docs.deepseek.com/quick_start/pricing', 'public-list-price'),
  ('pricing-zhipu-glm-4v-flash-v1', 'zhipu', 'vision_analysis', 'glm-4v-flash', 1, 'known', 'CNY', '{}', '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z', 'https://docs.bigmodel.cn/cn/guide/start/model-overview', 'official-free-model'),
  ('pricing-zhipu-cogview-flash-v1', 'zhipu', 'text_to_image', 'cogview-3-flash', 1, 'known', 'CNY', '{}', '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z', 'https://docs.bigmodel.cn/cn/guide/models/free/cogview-3-flash', 'official-free-model'),
  ('pricing-qwen-vision-unknown-v1', 'qwen', 'vision_analysis', 'qwen-vl-plus', 1, 'unknown', 'CNY', '{}', '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z', 'https://help.aliyun.com/zh/model-studio/qwen-vl-model-billing-notice', 'price-unverified'),
  ('pricing-hunyuan-vision-unknown-v1', 'hunyuan', 'vision_analysis', 'hunyuan-vision', 1, 'unknown', 'CNY', '{}', '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z', 'https://cloud.tencent.com/document/product/1729/97731', 'price-unverified');
