import "dotenv/config";
import { defineConfig } from "prisma/config";

/**
 * Prisma 7 配置。连接串从这里读（Migrate 用），运行时的 PrismaClient
 * 走 driver adapter（见 src/lib/prisma.ts）。
 */
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.DATABASE_URL ?? "",
  },
});
