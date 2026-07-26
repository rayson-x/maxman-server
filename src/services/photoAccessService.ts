import type { PrismaClient } from "../generated/prisma/client.js";
import { createPresignedReadUrl } from "../lib/ossUpload.js";

/**
 * 带审计的照片访问（tasks 10.4）。
 *
 * 合规要求：敏感照片访问需记录操作日志，尤其后台人工审核场景。
 *
 * 记录点选在**预签名 URL 签发**而不是 HTTP 读取。原因：我们无法拦截对象存储
 * 的直接读取（客户端拿到 URL 后直连 OSS，请求根本不经过我们），但签发是必经之路——
 * 没有签名就读不到私有 Bucket。所以签发即等于授予访问权，这是唯一真正可控的记录点。
 *
 * 一个诚实的局限：一次签发可能被读取多次（URL 有效期内可反复用）。日志记录的是
 * 「授权事件」而非「读取次数」，所以同时记 `expiresInSeconds` 来体现暴露窗口大小。
 */

export type AccessorType =
  /** 用户读自己的照片 */
  | "user"
  /** 后台人工审核——这是合规最关心的场景 */
  | "staff_review"
  /** 系统把图交给 AI 供应商处理 */
  | "system_provider";

export function createPhotoAccessService(prisma: PrismaClient) {
  return {
    /**
     * 签发预签名读取 URL 并记录审计日志。
     * **所有**读取敏感照片的路径都应走这里，而不是直接调 `createPresignedReadUrl`。
     */
    async issueReadUrl(params: {
      storageKey: string;
      photoId?: string;
      accessorType: AccessorType;
      accessorId?: string;
      purpose: string;
      expiresSeconds?: number;
      sourceIp?: string;
    }): Promise<{ url: string; expiresInSeconds: number }> {
      const expiresInSeconds = params.expiresSeconds ?? 600;

      const url = createPresignedReadUrl(params.storageKey, { expiresSeconds: expiresInSeconds });

      await prisma.photoAccessLog.create({
        data: {
          photoId: params.photoId,
          storageKey: params.storageKey,
          accessorType: params.accessorType,
          accessorId: params.accessorId,
          purpose: params.purpose,
          expiresInSeconds,
          sourceIp: params.sourceIp,
        },
      });

      return { url, expiresInSeconds };
    },

    /** 查某张照片的访问历史，供用户自查与合规审计 */
    async getAccessHistory(photoId: string) {
      return prisma.photoAccessLog.findMany({
        where: { photoId },
        orderBy: { createdAt: "desc" },
        take: 100,
      });
    },

    /** 后台人工审核的访问记录——合规检查最常被问到的就是这个 */
    async getStaffAccessHistory(opts: { since?: Date } = {}) {
      return prisma.photoAccessLog.findMany({
        where: { accessorType: "staff_review", createdAt: opts.since ? { gte: opts.since } : undefined },
        orderBy: { createdAt: "desc" },
        take: 500,
      });
    },
  };
}

export type PhotoAccessService = ReturnType<typeof createPhotoAccessService>;
