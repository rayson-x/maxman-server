import "dotenv/config";
import { createContainer } from "../app/container.js";
import { buildApp } from "../app/server.js";

/**
 * 验证应用能真正装配起来、health check 真的探测到了 DB 与 Redis。
 *
 * 用 app.inject() 而非真起端口——这也顺带证明了 DI 装配是可测的
 * （容器由外部传入，不是模块级单例）。
 *
 * withProviders: false —— 纯基础设施测试不该因为缺某个 AI 供应商的 key 而失败。
 * 这正是 DI 的收益之一。
 */
const container = createContainer({ withProviders: false });
const app = await buildApp({ container, logger: false });

try {
  const res = await app.inject({ method: "GET", url: "/health" });
  const body = res.json();

  console.log(`HTTP ${res.statusCode}`);
  console.log(JSON.stringify(body, null, 2));

  const dbOk = body.checks?.database?.ok === true;
  const redisOk = body.checks?.redis?.ok === true;
  const concurrencyOk = body.imageGenerationConcurrency === 1;

  console.log(`\n${dbOk ? "✅" : "❌"} health check 真实探测到 Postgres`);
  console.log(`${redisOk ? "✅" : "❌"} health check 真实探测到 Redis`);
  console.log(`${concurrencyOk ? "✅" : "❌"} image-generation 并发配置为 1（供应商硬约束，暴露给运维核对）`);
  console.log(`${res.statusCode === 200 ? "✅" : "❌"} 整体状态 200`);

  if (!dbOk || !redisOk || !concurrencyOk || res.statusCode !== 200) process.exit(1);
  console.log("\n应用装配验证通过。");
} finally {
  await app.close();
}
