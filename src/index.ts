import "dotenv/config";
import { createContainer } from "./app/container.js";
import { buildApp } from "./app/server.js";
import { env } from "./config/env.js";

/**
 * API 进程入口（tasks 1.7）。
 *
 * 与 worker 进程分离：API 只处理 HTTP 与轻量查询，需要 AI 处理的请求写入队列
 * 即返回。图片生成可能耗时数分钟，绝不能占用 API 的事件循环，且两者要能
 * 独立扩容——API 可以多副本，`image-generation` worker 因供应商并发=1 只能单副本。
 */
const container = createContainer();
const app = await buildApp({ container });

const shutdown = async (signal: string) => {
  app.log.info(`收到 ${signal}，开始优雅关闭`);
  await app.close(); // onClose hook 会调 container.shutdown()
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

try {
  await app.listen({ port: env.server.port, host: env.server.host });
} catch (err) {
  app.log.error(err);
  await container.shutdown();
  process.exit(1);
}
