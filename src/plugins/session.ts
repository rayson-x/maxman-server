import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { SESSION_COOKIE_NAME, resolveUserBySession } from "../services/sessionService.js";
import type { UserModel } from "../generated/prisma/models.js";

/**
 * Session 解析 hook（tasks 3.2）。
 *
 * 对所有请求解析 `device_session_id` Cookie 并把 User 挂到请求上下文。
 * 刻意**不在这里自动签发**——签发只发生在显式的 `POST /auth/device-session`。
 * 隐式签发会让任何一次探测请求（健康检查、爬虫、预检）都造一个 User 出来。
 *
 * 客户端还会把 id 双写 localStorage 作为 Cookie 丢失时的兜底，所以也接受
 * `X-Device-Session` 头——Cookie 没了但 localStorage 还在时用它恢复关联。
 */

declare module "fastify" {
  interface FastifyRequest {
    /** 当前请求关联的用户；未携带有效 session 时为 null */
    currentUser: UserModel | null;
    deviceSessionId: string | null;
  }
}

function readSessionId(req: FastifyRequest): string | undefined {
  const fromCookie = req.cookies?.[SESSION_COOKIE_NAME];
  if (fromCookie) return fromCookie;
  const header = req.headers["x-device-session"];
  return typeof header === "string" && header.length > 0 ? header : undefined;
}

export const sessionPlugin = fp(async (app: FastifyInstance) => {
  app.decorateRequest("currentUser", null);
  app.decorateRequest("deviceSessionId", null);

  app.addHook("onRequest", async (req) => {
    const sessionId = readSessionId(req);
    req.deviceSessionId = sessionId ?? null;
    req.currentUser = sessionId ? await resolveUserBySession(app.container.prisma, sessionId) : null;
  });
});

/**
 * 需要已登记用户的路由用它取 User。抛出的是带 statusCode 的错误，
 * 由 Fastify 统一转成 401，避免每个 handler 重复写判空。
 */
export function requireUser(req: FastifyRequest): UserModel {
  if (!req.currentUser) {
    const err = new Error("缺少有效的 device session，请先调用 POST /auth/device-session") as Error & { statusCode?: number };
    err.statusCode = 401;
    throw err;
  }
  return req.currentUser;
}
