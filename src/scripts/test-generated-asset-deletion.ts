import "dotenv/config";
import { createPrismaClient } from "../lib/prisma.js";
import { createDataDeletionService } from "../services/dataDeletionService.js";
import { createGeneratedAssetService } from "../services/generatedAssetService.js";

/**
 * 验证删除链路能枚举到预览图。
 *
 * 修的是一个实测缺口：预览图经 `persistGeneratedImage` 写入 OSS 后不写任何数据库行，
 * `storageKey` 只存在于 job 的 `partialResult` JSON 里；而删除服务的
 * `all_generated_images` 与 `account` 只查 `TargetImage`。
 * 后果是删除全部生成图或删号时，预览图的 OSS 对象删不掉。
 *
 * 用不存在的假 storageKey：OSS 删除不存在的对象是幂等空操作，不产生费用，
 * 而枚举与删除请求的行为与真实对象一致——被测的正是「有没有枚举到」。
 */

const prisma = createPrismaClient();
const assets = createGeneratedAssetService(prisma);
const deletion = createDataDeletionService(prisma);

let pass = 0, fail = 0;
const check = (ok: boolean, label: string, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? `  ${detail}` : ""}`);
};

const prefix = `asset-del-${Date.now()}`;
try {
  // ── ① 删除全部生成图：预览图必须被枚举到 ──
  {
    const user = await prisma.user.create({ data: { deviceSessionId: `${prefix}-a`, ageConfirmed18Plus: true } });
    const plan = await prisma.appearancePlan.create({ data: { userId: user.id, track: "short_term", generationSeed: 1 } });

    const r1 = await assets.record({
      userId: user.id, planId: plan.id, kind: "hairstyle_preview",
      storageKey: `generated/${user.id}/hair-preview-1.png`, provider: "stub",
    });
    await assets.record({
      userId: user.id, planId: plan.id, kind: "outfit_preview",
      storageKey: `generated/${user.id}/outfit-preview-1.png`, provider: "stub",
    });
    check(Boolean(r1.assetId), "预览图落资产台账");
    check(/AI/.test(r1.disclosure) || r1.disclosure.length > 0, "台账带显式标识文案", r1.disclosure.slice(0, 40));

    const before = await prisma.generatedAsset.count({ where: { userId: user.id } });
    const out = await deletion.executeDeletion(user.id, { kind: "all_generated_images" });
    check(before === 2, "两条预览资产已就位", `实际 ${before}`);
    check(
      out.objectsDeleted >= 2,
      "**删除全部生成图时预览图的 OSS 对象被枚举并删除**",
      `objectsDeleted=${out.objectsDeleted} failed=${out.objectsFailed.length}`,
    );
    check(out.objectsFailed.length === 0, "无删除失败项", out.objectsFailed.join(","));
  }

  // ── ② 删号：预览图与目标图都要清 ──
  {
    const user = await prisma.user.create({ data: { deviceSessionId: `${prefix}-b`, ageConfirmed18Plus: true } });
    const plan = await prisma.appearancePlan.create({ data: { userId: user.id, track: "short_term", generationSeed: 2 } });
    await assets.record({
      userId: user.id, planId: plan.id, kind: "hairstyle_preview",
      storageKey: `generated/${user.id}/hair-preview-2.png`, provider: "stub",
    });
    await assets.record({
      userId: user.id, planId: plan.id, kind: "target_image",
      storageKey: `generated/${user.id}/target-2.png`, provider: "stub", basedOnSelfReported: true,
    });

    const out = await deletion.executeDeletion(user.id, { kind: "account" });
    check(out.objectsDeleted >= 2, "**删号时两类生成图都被枚举**", `objectsDeleted=${out.objectsDeleted}`);

    const remaining = await prisma.generatedAsset.count({ where: { userId: user.id } });
    check(remaining === 0, "资产行随用户级联删除", `剩余 ${remaining}`);
    const userGone = await prisma.user.findUnique({ where: { id: user.id } });
    check(userGone === null, "用户已删除");
  }

  // ── ③ 台账的枚举接口：必须在删行之前可用 ──
  {
    const user = await prisma.user.create({ data: { deviceSessionId: `${prefix}-c`, ageConfirmed18Plus: true } });
    await assets.record({
      userId: user.id, kind: "hairstyle_preview",
      storageKey: `generated/${user.id}/x.png`, provider: "stub",
    });
    const keys = await assets.listStorageKeys({ userId: user.id, scope: "all" });
    check(keys.length === 1 && keys[0]!.endsWith("x.png"), "listStorageKeys 返回可删对象", keys.join(","));

    const onlyTarget = await assets.listStorageKeys({ userId: user.id, scope: "all", kinds: ["target_image"] });
    check(onlyTarget.length === 0, "按 kind 过滤生效");
  }

  console.log(`\n${fail === 0 ? "全部通过" : "有失败项"}：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exitCode = 1;
} finally {
  await prisma.user.deleteMany({ where: { deviceSessionId: { startsWith: prefix } } });
  await prisma.$disconnect();
}
