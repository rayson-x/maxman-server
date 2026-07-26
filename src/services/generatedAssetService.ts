import type { PrismaClient } from "../generated/prisma/client.js";
import type { GeneratedAssetKind } from "../generated/prisma/enums.js";
import { buildDisclosure } from "../lib/aiContentLabel.js";

/**
 * 生成图片的资产台账。**每张生成图先在这里落一行，再对用户签发读取地址。**
 *
 * 存在的理由是删除链路的一个实测缺口：预览图经 `persistGeneratedImage` 写入 OSS 后
 * 不写任何数据库行，`storageKey` 只存在于 job 的 `partialResult` JSON 里；
 * 而删除服务的 `all_generated_images` 与 `account` 只枚举 `TargetImage` 表。
 * 后果是删除全部生成图或删号时，预览图的 OSS 对象删不掉——
 * 从删除路径的视角看它们本来就是孤儿。
 *
 * `disclosure` 一并存下来：AI 生成内容的**显式标识**要能从台账取回，
 * 而不是每次展示时重新拼（隐式标识写在图片元数据里，由持久化环节完成）。
 */

export type RecordGeneratedAssetParams = {
  userId: string;
  kind: GeneratedAssetKind;
  storageKey: string;
  provider: string;
  planId?: string;
  candidateId?: string;
  providerCallId?: string;
  /** 目标图基于用户自报的完成情况生成时置真，会体现在标识文案里 */
  basedOnSelfReported?: boolean;
};

export function createGeneratedAssetService(prisma: PrismaClient) {
  return {
    async record(params: RecordGeneratedAssetParams): Promise<{ assetId: string; disclosure: string }> {
      const disclosure = buildDisclosure({
        isSimulated: true,
        basedOnSelfReported: params.basedOnSelfReported,
      });
      const asset = await prisma.generatedAsset.create({
        data: {
          userId: params.userId,
          planId: params.planId,
          candidateId: params.candidateId,
          kind: params.kind,
          storageKey: params.storageKey,
          provider: params.provider,
          providerCallId: params.providerCallId,
          disclosure,
        },
      });
      return { assetId: asset.id, disclosure };
    },

    /**
     * 供删除链路枚举 OSS 对象。
     * 必须在删除数据库行**之前**调用——行删掉之后 storageKey 就找不回来了，
     * 那些文件会成为永久孤儿。
     */
    async listStorageKeys(params: {
      userId: string;
      scope: "all" | "single";
      assetId?: string;
      kinds?: GeneratedAssetKind[];
    }): Promise<string[]> {
      const rows = await prisma.generatedAsset.findMany({
        where: {
          userId: params.userId,
          ...(params.scope === "single" && params.assetId ? { id: params.assetId } : {}),
          ...(params.kinds ? { kind: { in: params.kinds } } : {}),
        },
        select: { storageKey: true },
      });
      return rows.map((r) => r.storageKey);
    },
  };
}

export type GeneratedAssetService = ReturnType<typeof createGeneratedAssetService>;
