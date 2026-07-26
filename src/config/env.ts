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
  server: {
    port: Number(optional("PORT") ?? "8787"),
    uploadDir: optional("UPLOAD_DIR") ?? "./tmp-uploads",
    isProduction: (optional("NODE_ENV") ?? "development") === "production",
  },
};

export { required };
