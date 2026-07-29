-- Complete the initial rule snapshot for every provider-operation currently
-- executable by the service. Unknown means "usage is recorded, price is not
-- safely known"; it never means free.
INSERT INTO "ProviderPricingRule" (
  "id", "provider", "operation", "model", "version", "costState", "currency",
  "unitPrices", "effectiveAt", "checkedAt", "sourceUrl", "sourceScope"
) VALUES
  ('pricing-zhipu-style-recommendation-v1', 'zhipu', 'style_recommendation', 'glm-4v-flash', 1, 'known', 'CNY', '{}', '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z', 'https://docs.bigmodel.cn/cn/guide/start/model-overview', 'official-free-model'),
  ('pricing-zhipu-hairstyle-recommendation-v1', 'zhipu', 'hairstyle_recommendation', 'glm-4.6v', 1, 'unknown', 'CNY', '{}', '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z', 'https://docs.bigmodel.cn/cn/guide/models/vlm/glm-4.6v', 'price-unverified'),
  ('pricing-zhipu-outfit-recommendation-v1', 'zhipu', 'outfit_recommendation', 'glm-4.6v', 1, 'unknown', 'CNY', '{}', '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z', 'https://docs.bigmodel.cn/cn/guide/models/vlm/glm-4.6v', 'price-unverified'),
  ('pricing-zhipu-dual-source-recommendation-v1', 'zhipu', 'dual_source_recommendation', 'glm-4.6v', 1, 'unknown', 'CNY', '{}', '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z', 'https://docs.bigmodel.cn/cn/guide/models/vlm/glm-4.6v', 'price-unverified'),
  ('pricing-open-meteo-geocoding-v1', 'open-meteo', 'geocoding', '*', 1, 'unknown', 'CNY', '{}', '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z', 'https://open-meteo.com/en/pricing', 'commercial-plan-required'),
  ('pricing-open-meteo-historical-weather-v1', 'open-meteo', 'historical_weather', '*', 1, 'unknown', 'CNY', '{}', '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z', 'https://open-meteo.com/en/pricing', 'commercial-plan-required'),
  ('pricing-open-meteo-forecast-weather-v1', 'open-meteo', 'forecast_weather', '*', 1, 'unknown', 'CNY', '{}', '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z', 'https://open-meteo.com/en/pricing', 'commercial-plan-required'),
  ('pricing-aliyun-oss-put-object-v1', 'aliyun-oss', 'put_object', '*', 1, 'unknown', 'CNY', '{}', '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z', 'https://help.aliyun.com/zh/oss/billing-overview', 'bucket-configuration-required'),
  ('pricing-aliyun-oss-delete-object-v1', 'aliyun-oss', 'delete_object', '*', 1, 'unknown', 'CNY', '{}', '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z', 'https://help.aliyun.com/zh/oss/billing-overview', 'bucket-configuration-required');
