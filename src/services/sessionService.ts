import { randomUUID } from "node:crypto";
import type { PrismaClient } from "../generated/prisma/client.js";

/**
 * 匿名身份（tasks 3.1/3.2）。
 *
 * MVP1 不做鉴权：无 JWT、无短信登录。用 `device_session_id` 关联请求到 User。
 * `phone` 保留可空，为下一轮「匿名账号绑定手机号」的升级路径留位。
 *
 * 服务只接收 prisma 作为参数，不 import 全局单例——DI 要求（tasks 1.6）。
 */

export const SESSION_COOKIE_NAME = "bm_device_session";
/** 长期 Cookie：匿名身份是用户找回方案的唯一凭据，短期过期等于丢方案 */
export const SESSION_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 3600;

export type DeviceSessionResult = {
  deviceSessionId: string;
  userId: string;
  /** true 表示复用了已有会话（幂等），false 表示新建 */
  reused: boolean;
};

/**
 * 幂等签发。已有有效 session 时**返回现有的**而不是新建——
 * 否则客户端重复调用会给同一个人造出多个 User，方案数据分裂。
 */
export async function issueDeviceSession(
  prisma: PrismaClient,
  existingSessionId: string | undefined,
): Promise<DeviceSessionResult> {
  if (existingSessionId) {
    const existing = await prisma.user.findUnique({ where: { deviceSessionId: existingSessionId } });
    if (existing) {
      return { deviceSessionId: existing.deviceSessionId, userId: existing.id, reused: true };
    }
    // Cookie 里的 id 在库中不存在（例如库被重置）——不复用这个 id，重新签发一个干净的
  }

  const deviceSessionId = randomUUID();
  const user = await prisma.user.create({ data: { deviceSessionId } });
  return { deviceSessionId, userId: user.id, reused: false };
}

/** 解析请求携带的 session 到 User。找不到返回 null，由调用方决定是 401 还是自动签发。 */
export async function resolveUserBySession(prisma: PrismaClient, deviceSessionId: string | undefined) {
  if (!deviceSessionId) return null;
  return prisma.user.findUnique({ where: { deviceSessionId } });
}
