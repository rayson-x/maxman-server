import { PrismaClient } from "../generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { env, required } from "../config/env.js";

/**
 * Prisma 7 客户端工厂。连接串通过 driver adapter 注入，不再由 schema 读 env。
 *
 * 刻意导出**工厂函数而非单例**：依赖注入要求 PrismaClient 由组装根构造并向下
 * 传递（Fastify plugin + decorate），业务 service 显式接收依赖，不 import 全局单例。
 * 这样测试里可以注入独立实例或事务包裹的 client，不需要打全局 mock。
 */
export function createPrismaClient(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: required("DATABASE_URL") });
  return new PrismaClient({
    adapter,
    log: env.server.isProduction ? ["warn", "error"] : ["warn", "error"],
  });
}

export type { PrismaClient };
