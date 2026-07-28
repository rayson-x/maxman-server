import "dotenv/config";

function optional(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

function required(name: string): string {
  const v = optional(name);
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const env = {
  deepseek: {
    apiKey: optional("DEEPSEEK_API_KEY"),
    baseURL: optional("DEEPSEEK_BASE_URL") ?? "https://api.deepseek.com",
  },
  zhipu: {
    apiKey: optional("ZHIPU_API_KEY"),
    baseURL: optional("ZHIPU_BASE_URL") ?? "https://open.bigmodel.cn/api/paas/v4",
  },
  aliyun: {
    dashscopeApiKey: optional("ALIYUN_DASHSCOPE_API_KEY"),
    openaiBaseURL: optional("ALIYUN_DASHSCOPE_OPENAI_BASE_URL"),
    nativeBaseURL: optional("ALIYUN_DASHSCOPE_NATIVE_BASE_URL"),
  },
  volc: {
    accessKeyId: optional("VOLC_ACCESS_KEY_ID"),
    secretAccessKey: optional("VOLC_SECRET_ACCESS_KEY"),
    region: optional("VOLC_REGION") ?? "cn-north-1",
    visualHost: optional("VOLC_VISUAL_HOST") ?? "visual.volcengineapi.com",
  },
  // 火山方舟（ARK）跟上面的「视觉智能」是两套凭证：视觉智能用 AK/SK 签名，
  // 方舟用 Bearer API Key。Seedream 4.0+ 只在方舟上，所以两套都得留。
  ark: {
    apiKey: optional("ARK_API_KEY"),
    baseURL: optional("ARK_BASE_URL") ?? "https://ark.cn-beijing.volces.com/api/v3",
  },
  hunyuan: {
    apiKey: optional("TENCENT_HUNYUAN_API_KEY"),
    baseURL: optional("TENCENT_HUNYUAN_BASE_URL") ?? "https://api.hunyuan.cloud.tencent.com/v1",
  },
  aliyunOss: {
    accessKeyId: optional("ALIYUN_OSS_ACCESS_KEY_ID"),
    accessKeySecret: optional("ALIYUN_OSS_ACCESS_KEY_SECRET"),
    bucket: optional("ALIYUN_OSS_BUCKET"),
    region: optional("ALIYUN_OSS_REGION"),
  },
  stepfun: {
    apiKey: optional("STEPFUN_API_KEY"),
    baseURL: optional("STEPFUN_BASE_URL") ?? "https://api.stepfun.com/v1",
  },
  database: {
    url: optional("DATABASE_URL"),
  },
  redis: {
    url: optional("REDIS_URL") ?? "redis://localhost:6379",
  },
  weather: {
    geocodingOrigin:
      optional("WEATHER_GEOCODING_ORIGIN") ??
      "https://geocoding-api.open-meteo.com",
    archiveOrigin:
      optional("WEATHER_ARCHIVE_ORIGIN") ??
      "https://archive-api.open-meteo.com",
    forecastOrigin:
      optional("WEATHER_FORECAST_ORIGIN") ?? "https://api.open-meteo.com",
    apiKey: optional("WEATHER_API_KEY"),
    historyDir:
      optional("WEATHER_HISTORY_DIR") ?? "./data/weather-history",
    historyRefreshHours: Number(
      optional("WEATHER_HISTORY_REFRESH_HOURS") ?? "168",
    ),
    forecastDays: Number(optional("WEATHER_FORECAST_DAYS") ?? "7"),
    requestTimeoutMs: Number(
      optional("WEATHER_REQUEST_TIMEOUT_MS") ?? "8000",
    ),
    maxResponseBytes: Number(
      optional("WEATHER_MAX_RESPONSE_BYTES") ?? String(2 * 1024 * 1024),
    ),
  },
  server: {
    port: Number(optional("PORT") ?? "8787"),
    uploadDir: optional("UPLOAD_DIR") ?? "./tmp-uploads",
    /**
     * 放宽照片审核门槛到 `pending`，仅供本地与内部测试。
     * 生产环境**不要设**——它会让审核 provider 缺位期间的所有照片直接通行。
     * 与 `isProduction` 解耦是刻意的：漏设 NODE_ENV 不能等于放宽安全边界。
     */
    allowPendingModeration:
      process.env.ALLOW_PENDING_MODERATION === "1" && process.env.NODE_ENV !== "production",
    isProduction: (optional("NODE_ENV") ?? "development") === "production",
  },
};

export { required };
