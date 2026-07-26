import type { FastifyInstance } from "fastify";
import {
  issueDeviceSession,
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_MAX_AGE_SECONDS,
} from "../services/sessionService.js";

/** tasks 3.1：显式、幂等的匿名会话签发 */
export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post("/auth/device-session", async (req, reply) => {
    const result = await issueDeviceSession(app.container.prisma, req.deviceSessionId ?? undefined);

    reply.setCookie(SESSION_COOKIE_NAME, result.deviceSessionId, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
      secure: process.env.NODE_ENV === "production",
    });

    return reply.code(result.reused ? 200 : 201).send({
      deviceSessionId: result.deviceSessionId,
      reused: result.reused,
    });
  });
}
