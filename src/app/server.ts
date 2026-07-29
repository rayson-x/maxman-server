import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import { ZodError } from "zod";
import type { AppContainer } from "./container.js";
import { registerHealthRoutes } from "../routes/health.js";
import { registerAuthRoutes } from "../routes/auth.js";
import { registerIntakeRoutes } from "../routes/intake.js";
import { registerAnalysisJobRoutes } from "../routes/analysisJobs.js";
import { registerPlanRoutes } from "../routes/plans.js";
import { registerPrivacyRoutes } from "../routes/privacy.js";
import { registerConversationRoutes } from "../routes/conversation.js";
import { registerProviderCostRoutes } from "../routes/providerCosts.js";
import { sessionPlugin } from "../plugins/session.js";

/**
 * Fastify 应用工厂（tasks 1.1）。
 *
 * 容器通过 `decorate` 挂到实例上，route handler 用 `app.container` 取依赖——
 * 这是 Fastify 原生的 DI 机制，不引入额外的 IoC 容器库。零新增依赖，
 * 且 `app.inject()` 测试时可以传入替身容器。
 */
export type BuildAppOptions = {
  container: AppContainer;
  logger?: boolean;
};

declare module "fastify" {
  interface FastifyInstance {
    container: AppContainer;
  }
}

export async function buildApp({ container, logger = true }: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: logger ? { level: process.env.LOG_LEVEL ?? "info" } : false,
    // 匿名 device_session_id 走 Cookie，需要信任代理头以拿到真实 IP（ConsentRecord.sourceIp）
    trustProxy: true,
  });

  await app.register(cookie);

  // 照片中转上传的原始字节解析（/photos/upload-relay）。
  // 浏览器直连 OSS 的预签名 PUT 受 bucket CORS 约束，中转路径让客户端只跟本服务通信。
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body)
  );

  // Web 客户端跨域（Cookie 会话需要 credentials；X-Device-Session 是 localStorage 兜底头）
  await app.register(cors, {
    origin: process.env.CORS_ORIGIN?.split(",") ?? [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
    ],
    credentials: true,
    // Idempotency-Key 是建 job 的必需头（analysisJobs.ts 缺了就 400）。
    // 不列进来的话浏览器预检直接拒绝，整条生成链路在 Web 端不可用 ——
    // Node 侧的 E2E 不走预检，测不出这个。
    allowedHeaders: ["Content-Type", "X-Device-Session", "Idempotency-Key", "X-Admin-Cost-Token"],
  });

  app.decorate("container", container);

  // session 解析必须在路由之前注册，否则 handler 里 req.currentUser 恒为 null
  await app.register(sessionPlugin);

  // zod 校验失败转 400 并带上字段级错误，而不是漏成 500
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: "validation_failed",
        issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    const status = (err as unknown as { statusCode?: number })?.statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    return reply.code(status).send({ error: err instanceof Error ? err.message : String(err) });
  });

  await registerHealthRoutes(app);
  await registerAuthRoutes(app);
  await registerIntakeRoutes(app);
  await registerAnalysisJobRoutes(app);
  await registerPlanRoutes(app);
  await registerPrivacyRoutes(app);
  await registerConversationRoutes(app);
  await registerProviderCostRoutes(app);

  app.addHook("onClose", async () => {
    await container.shutdown();
  });

  return app;
}
