import type { FastifyInstance } from "fastify";
import { requireUser } from "../plugins/session.js";
import { createDataDeletionService, type DeletionScope } from "../services/dataDeletionService.js";
import { createPhotoAccessService } from "../services/photoAccessService.js";
import { QUEUE_NAMES } from "../lib/queues.js";

/**
 * 隐私与合规路由（tasks 10.1/10.4）。
 *
 * MVP1 说明：客户端的「我的」Tab 已砍掉，所以这些端点暂时没有前端入口。
 * 它们仍然必须存在——删除权不能因为「界面还没做」而缺位，运营/客服也需要
 * 一个能受理删除请求的入口。
 */
export async function registerPrivacyRoutes(app: FastifyInstance): Promise<void> {
  const { prisma, queues } = app.container;
  const deletion = createDataDeletionService(prisma);
  const access = createPhotoAccessService(prisma);

  /** 统一的删除受理：标记 pending → 入队 → 立即返回 */
  async function accept(userId: string, scope: DeletionScope) {
    const result = await deletion.markPending(userId, scope);
    await queues.queues[QUEUE_NAMES.moderation].add("data_deletion", { userId, scope });
    return result;
  }

  app.delete("/me/photos/:photoId", async (req, reply) => {
    const user = requireUser(req);
    const { photoId } = req.params as { photoId: string };
    return reply.code(202).send(await accept(user.id, { kind: "single_photo", photoId }));
  });

  app.delete("/me/photos", async (req, reply) => {
    const user = requireUser(req);
    return reply.code(202).send(await accept(user.id, { kind: "all_photos" }));
  });

  app.delete("/me/target-images/:targetImageId", async (req, reply) => {
    const user = requireUser(req);
    const { targetImageId } = req.params as { targetImageId: string };
    return reply.code(202).send(await accept(user.id, { kind: "single_target_image", targetImageId }));
  });

  app.delete("/me/generated-images", async (req, reply) => {
    const user = requireUser(req);
    return reply.code(202).send(await accept(user.id, { kind: "all_generated_images" }));
  });

  /** 派生特征（faceMetrics 几何数据）——不是图片但属生物特征派生数据，须可单删 */
  app.delete("/me/derived-features", async (req, reply) => {
    const user = requireUser(req);
    return reply.code(202).send(await accept(user.id, { kind: "derived_features" }));
  });

  app.delete("/me/profile", async (req, reply) => {
    const user = requireUser(req);
    return reply.code(202).send(await accept(user.id, { kind: "profile" }));
  });

  app.delete("/me", async (req, reply) => {
    const user = requireUser(req);
    return reply.code(202).send(await accept(user.id, { kind: "account" }));
  });

  /** 用户自查自己照片的被访问记录（含后台人工审核）——透明度要求 */
  app.get("/me/photos/:photoId/access-log", async (req, reply) => {
    const user = requireUser(req);
    const { photoId } = req.params as { photoId: string };

    const photo = await prisma.userPhoto.findFirst({ where: { id: photoId, userId: user.id } });
    if (!photo) return reply.code(404).send({ error: "照片不存在" });

    const logs = await access.getAccessHistory(photoId);
    return reply.send({
      photoId,
      accessCount: logs.length,
      logs: logs.map((l) => ({
        accessorType: l.accessorType,
        purpose: l.purpose,
        // 暴露窗口大小比"访问了几次"更能说明风险——一次签发在有效期内可被反复读取
        exposureWindowSeconds: l.expiresInSeconds,
        at: l.createdAt,
      })),
    });
  });

  /** 撤回同意（三类同意互相独立、可单独撤回） */
  app.post("/me/consents/:consentId/revoke", async (req, reply) => {
    const user = requireUser(req);
    const { consentId } = req.params as { consentId: string };

    const consent = await prisma.consentRecord.findFirst({ where: { id: consentId, userId: user.id } });
    if (!consent) return reply.code(404).send({ error: "同意记录不存在" });
    if (consent.revokedAt) return reply.send({ ok: true, alreadyRevoked: true, revokedAt: consent.revokedAt });

    const updated = await prisma.consentRecord.update({
      where: { id: consentId },
      data: { revokedAt: new Date() },
    });

    // 撤回人脸处理同意 = 不再允许处理人脸数据，须连带受理照片删除
    let photoDeletionAccepted = false;
    if (consent.consentType === "face_processing") {
      await accept(user.id, { kind: "all_photos" });
      photoDeletionAccepted = true;
    }

    return reply.send({
      ok: true,
      revokedAt: updated.revokedAt,
      photoDeletionAccepted,
      notice: photoDeletionAccepted
        ? "已撤回人脸信息处理同意，并同时受理了你全部照片的删除。"
        : "已撤回该项同意。",
    });
  });
}
