-- Fixed vision-model evaluation uses its own business operation so benchmark
-- spend remains distinguishable from customer-facing vision analysis. Prices
-- are snapshots of public realtime API rates; unknown is deliberate, never free.
INSERT INTO "ProviderPricingRule" (
  "id", "provider", "operation", "model", "version", "costState", "currency",
  "unitPrices", "effectiveAt", "checkedAt", "sourceUrl", "sourceScope"
) VALUES
  ('pricing-zhipu-model-evaluation-glm-4v-flash-v1', 'zhipu', 'model_evaluation', 'glm-4v-flash', 1, 'known', 'CNY', '{}', '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z', 'https://docs.bigmodel.cn/cn/guide/start/model-overview', 'official-free-model'),
  ('pricing-zhipu-model-evaluation-glm-4-6v-v1', 'zhipu', 'model_evaluation', 'glm-4.6v', 1, 'known', 'CNY', '{"cacheMissInputToken": 0.000001, "cacheHitInputToken": 0.0000002, "outputToken": 0.000003}', '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z', 'https://bigmodel.cn/pricing', 'official-realtime-under-32k'),
  ('pricing-zhipu-model-evaluation-glm-5v-turbo-v1', 'zhipu', 'model_evaluation', 'glm-5v-turbo', 1, 'known', 'CNY', '{"cacheMissInputToken": 0.000005, "cacheHitInputToken": 0.0000012, "outputToken": 0.000022}', '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z', 'https://bigmodel.cn/pricing', 'official-realtime-under-32k'),
  ('pricing-qwen-vl-model-evaluation-qwen-vl-plus-v1', 'qwen-vl', 'model_evaluation', 'qwen-vl-plus', 1, 'known', 'CNY', '{"inputToken": 0.0000015, "outputToken": 0.0000045}', '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z', 'https://help.aliyun.com/en/model-studio/qwen-vl-model-billing-notice', 'official-realtime-china-mainland'),
  ('pricing-hunyuan-vision-model-evaluation-v1', 'hunyuan-vision', 'model_evaluation', 'hunyuan-vision', 1, 'unknown', 'CNY', '{}', '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z', 'https://cloud.tencent.com/document/product/1729/97731', 'provider-unavailable-price-unverified');
