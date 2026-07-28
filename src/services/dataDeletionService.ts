import type { PrismaClient } from "../generated/prisma/client.js";
import { DbNull } from "../generated/prisma/internal/prismaNamespace.js";
import { deleteObjects } from "../lib/ossUpload.js";

/**
 * 分级数据删除（tasks 10.1/10.2）。
 *
 * 合规要求（技术架构 §十）：单张原图 / 全部原图 / 单张目标图 / 全部生成图 /
 * 派生特征 / 完整档案 / 整个账号，各自独立可删。
 *
 * 删除是**异步**的：接口立即标记 pending 并返回，实际清理（对象存储 + 跨表级联）
 * 由队列执行并支持重试。这不是偷懒——对象存储删除会失败（网络、限流），
 * 同步执行会让用户的删除请求因为一次网络抖动而失败，而删除是不可拒绝的权利。
 *
 * 因此 API 的语义是「已受理」而非「已完成」，UI 必须如实告知而不能说"已删除"。
 */

export type DeletionScope =
  | { kind: "single_photo"; photoId: string }
  | { kind: "all_photos" }
  | { kind: "single_target_image"; targetImageId: string }
  | { kind: "all_generated_images" }
  | { kind: "derived_features" }
  | { kind: "profile" }
  | { kind: "account" };

export type DeletionAcceptance = {
  accepted: true;
  scope: DeletionScope["kind"];
  /** 受影响的记录数，让用户知道范围 */
  affectedCount: number;
  /** 明确告知这是受理而非完成 */
  status: "pending";
  notice: string;
};

export function createDataDeletionService(prisma: PrismaClient) {
  /** 标记待删除。立即返回，实际清理交队列。 */
  async function markPending(userId: string, scope: DeletionScope): Promise<DeletionAcceptance> {
    let affectedCount = 0;

    switch (scope.kind) {
      case "single_photo": {
        const r = await prisma.userPhoto.updateMany({
          where: { id: scope.photoId, userId, deletionStatus: "active" },
          data: { deletionStatus: "pending" },
        });
        affectedCount = r.count;
        break;
      }
      case "all_photos": {
        const r = await prisma.userPhoto.updateMany({
          where: { userId, deletionStatus: "active" },
          data: { deletionStatus: "pending" },
        });
        // A comparison log contains versioned face/body/profile references.
        // Revoking face processing must not leave that identifiable chain
        // behind merely because it is not an image row.
        const comparisons = await prisma.recommendationComparisonLog.count({ where: { userId } });
        affectedCount = r.count + comparisons;
        break;
      }
      case "single_target_image":
      case "all_generated_images": {
        // TargetImage 没有 deletionStatus 字段——生成图不存在"保留原图但删派生"的
        // 中间态需求，直接由队列删。这里只统计范围告知用户。
        affectedCount = await prisma.targetImage.count({
          where:
            scope.kind === "single_target_image"
              ? { id: scope.targetImageId, plan: { userId } }
              : { plan: { userId } },
        });
        break;
      }
      case "derived_features": {
        // 派生特征即 faceMetrics（客户端算出的几何数据）。
        // 它不是图片但属于生物特征派生数据，必须可单独删除。
        affectedCount = await prisma.userPhoto.count({ where: { userId, faceMetrics: { not: DbNull } } });
        break;
      }
      case "profile": {
        affectedCount = await prisma.appearanceProfile.count({ where: { userId } });
        break;
      }
      case "account": {
        affectedCount = 1;
        await prisma.userPhoto.updateMany({ where: { userId }, data: { deletionStatus: "pending" } });
        break;
      }
    }

    return {
      accepted: true,
      scope: scope.kind,
      affectedCount,
      status: "pending",
      notice: "删除请求已受理，后台会在数小时内完成清理。期间相关内容可能仍短暂可见。",
    };
  }

  /**
   * 执行实际清理（由队列 worker 调用，tasks 10.2）。
   * 顺序很重要：**先删对象存储，再删数据库记录**——反过来的话，
   * 一旦对象存储删除失败，我们就永久失去了 storageKey，那些文件会成为孤儿永远删不掉。
   */
  async function executeDeletion(userId: string, scope: DeletionScope): Promise<{
    objectsDeleted: number;
    objectsFailed: string[];
    rowsDeleted: number;
  }> {
    const storageKeys: string[] = [];
    let rowsDeleted = 0;

    // ⚠ 必须在任何删除动作**之前**收集 callId。account 分支会 `user.delete()`，
    // 级联带走 TargetImage，之后就再也反查不到这些 callId 了。
    const providerCallIds = (
      await prisma.targetImage.findMany({
        where: { plan: { userId }, providerCallId: { not: null } },
        select: { providerCallId: true },
      })
    )
      .map((t) => t.providerCallId)
      .filter((id): id is string => Boolean(id));

    if (scope.kind === "single_photo" || scope.kind === "all_photos" || scope.kind === "account") {
      const photos = await prisma.userPhoto.findMany({
        where:
          scope.kind === "single_photo"
            ? { id: scope.photoId, userId }
            : { userId, deletionStatus: "pending" },
        select: { id: true, storageKey: true },
      });
      storageKeys.push(...photos.map((p) => p.storageKey));

      // 级联：这些照片作为 baseline 生成的目标图也要删（合规要求的级联清理）
      const derived = await prisma.targetImage.findMany({
        where: { baselinePhotoId: { in: photos.map((p) => p.id) } },
        select: { storageKey: true },
      });
      storageKeys.push(...derived.map((t) => t.storageKey).filter((k): k is string => Boolean(k)));

      /**
       * 预览图也是人脸派生数据，必须随原图一起清。
       *
       * 首版只把 `GeneratedAsset` 的枚举放在「删生成图/删号」那个分支里，
       * 于是**撤回人脸处理同意**这条路径（它自动受理 all_photos）会删掉原图、
       * 却把用户人脸的 AI 生成图永久留在 OSS 与库中。撤回同意恰恰是合规上
       * 最不能漏的出口。
       *
       * 只在「清掉全部照片」时做无条件枚举。`single_photo` 不能这样做：
       * GeneratedAsset 目前没有回指 baseline 照片的外键，无条件枚举等于删一张照片
       * 就清空该用户所有预览图——那是把过删 bug 换个地方重犯。删单张照片时能确定
       * 归属的只有经 baselinePhotoId 反查到的目标图（上面的 `derived` 已覆盖）。
       */
      if (scope.kind !== "single_photo") {
        const faceDerived = await prisma.generatedAsset.findMany({
          where: { userId, kind: { in: ["hairstyle_preview", "outfit_preview", "target_image"] } },
          select: { storageKey: true },
        });
        storageKeys.push(...faceDerived.map((a) => a.storageKey));
      }
    }

    if (scope.kind === "single_target_image" || scope.kind === "all_generated_images" || scope.kind === "account") {
      const images = await prisma.targetImage.findMany({
        where:
          scope.kind === "single_target_image"
            ? { id: scope.targetImageId, plan: { userId } }
            : { plan: { userId } },
        select: { storageKey: true },
      });
      const targetKeys = images.map((t) => t.storageKey).filter((k): k is string => Boolean(k));
      storageKeys.push(...targetKeys);

      // 预览图不在 TargetImage 里——它们经 GeneratedAsset 台账枚举。
      // 此前只查 TargetImage，导致删除全部生成图或删号时预览图的 OSS 对象删不掉。
      //
      // ⚠ single_target_image 必须按 storageKey 精确定位。首版写成
      // `{userId, kind:"target_image"}`（无 id 过滤），后果是删一张目标图会删掉
      // 该用户**所有**目标图的 OSS 对象，而只删掉一行 TargetImage——
      // 其余行从此指向不存在的文件。这是数据丢失，不是多删几个字节。
      const assets = await prisma.generatedAsset.findMany({
        where:
          scope.kind === "single_target_image"
            ? { userId, storageKey: { in: targetKeys } }
            : { userId },
        select: { storageKey: true },
      });
      storageKeys.push(...assets.map((a) => a.storageKey));
    }

    // 资产行随对象一起清理：只删对象会留下指向不存在文件的行，
    // 之后的删除请求会反复尝试删已删对象
    if (scope.kind !== "account" && storageKeys.length > 0) {
      await prisma.generatedAsset.deleteMany({ where: { userId, storageKey: { in: storageKeys } } });
    }

    // 先删对象存储
    const unique = [...new Set(storageKeys)];
    const objectResult = unique.length > 0 ? await deleteObjects(unique) : { requested: 0, failed: [] };

    // 对象存储清理成功后才删数据库记录
    if (objectResult.failed.length === 0) {
      switch (scope.kind) {
        case "single_photo": {
          const r = await prisma.userPhoto.deleteMany({ where: { id: scope.photoId, userId } });
          rowsDeleted = r.count;
          break;
        }
        case "all_photos": {
          const [photos, comparisons] = await prisma.$transaction([
            prisma.userPhoto.deleteMany({ where: { userId, deletionStatus: "pending" } }),
            // Cascades remove channel runs, exposures, choices, outcomes,
            // reviewer results and catalog-gap links. Anonymous aggregates, if
            // introduced later, must be written separately without user refs.
            prisma.recommendationComparisonLog.deleteMany({ where: { userId } }),
          ]);
          rowsDeleted = photos.count + comparisons.count;
          break;
        }
        case "single_target_image": {
          const r = await prisma.targetImage.deleteMany({ where: { id: scope.targetImageId, plan: { userId } } });
          rowsDeleted = r.count;
          break;
        }
        case "all_generated_images": {
          const r = await prisma.targetImage.deleteMany({ where: { plan: { userId } } });
          rowsDeleted = r.count;
          break;
        }
        case "derived_features": {
          // 只清 faceMetrics 字段，照片本身保留
          const r = await prisma.userPhoto.updateMany({ where: { userId }, data: { faceMetrics: DbNull } });
          rowsDeleted = r.count;
          break;
        }
        case "profile": {
          const r = await prisma.appearanceProfile.deleteMany({ where: { userId } });
          rowsDeleted = r.count;
          break;
        }
        case "account": {
          // Prisma schema 里的 onDelete: Cascade 会带走全部关联数据
          await prisma.user.delete({ where: { id: userId } });
          rowsDeleted = 1;
          break;
        }
      }
    }

    // 脱敏日志引用：ProviderCallLog 的 requestSummary 里可能含照片 URL，
    // 删除用户数据时把它们抹掉，但**保留调用记录本身**用于成本统计。
    //
    // ⚠ 必须按 callId 精确定位。ProviderCallLog 没有 userId 字段（它按 callId 索引），
    // 若不加这个过滤，删一个用户的账号会把**所有用户**的日志都脱敏掉。
    // 该用户的 callId 通过 TargetImage.providerCallId 反查。
    if ((scope.kind === "account" || scope.kind === "all_photos") && providerCallIds.length > 0) {
      await prisma.providerCallLog.updateMany({
        where: { callId: { in: providerCallIds } },
        data: { requestSummary: { redacted: true, reason: "用户数据已删除" } as never },
      });
    }

    return { objectsDeleted: objectResult.requested - objectResult.failed.length, objectsFailed: objectResult.failed, rowsDeleted };
  }

  return { markPending, executeDeletion };
}

export type DataDeletionService = ReturnType<typeof createDataDeletionService>;
