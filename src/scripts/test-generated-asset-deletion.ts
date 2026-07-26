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

  // ── ④ 删单张目标图**只能**删这一张的对象 ──
  //
  // 回归：资产查询曾写成 `{userId, kind:"target_image", planId:{not:null}}`——没有
  // id 过滤。删一张目标图会把该用户所有目标图的 OSS 对象删掉，而只删一行
  // TargetImage，其余行从此指向不存在的文件。这是数据丢失，必须有断言守着。
  {
    const user = await prisma.user.create({ data: { deviceSessionId: `${prefix}-d`, ageConfirmed18Plus: true } });
    const plan = await prisma.appearancePlan.create({ data: { userId: user.id, track: "short_term", generationSeed: 4 } });
    const stage = await prisma.stage.create({
      data: { planId: plan.id, stageIndex: 1, windowLabel: "1-2 周", unlockRule: {} },
    });
    const baseline = await prisma.userPhoto.create({
      data: { userId: user.id, photoType: "front", storageKey: `raw/${user.id}/base-d.jpg`, moderationStatus: "passed" },
    });
    const mk = async (n: number) => {
      const storageKey = `generated/${user.id}/target-keep-${n}.png`;
      const t = await prisma.targetImage.create({
        data: {
          planId: plan.id, stageId: stage.id, imageType: "face_hair", baselinePhotoId: baseline.id,
          manifestSnapshot: {}, plannedChangesSnapshot: {}, storageKey,
        },
      });
      await assets.record({
        userId: user.id, planId: plan.id, kind: "target_image", storageKey, provider: "stub", basedOnSelfReported: true,
      });
      return t;
    };
    const t1 = await mk(1);
    await mk(2);
    await mk(3);

    const out = await deletion.executeDeletion(user.id, { kind: "single_target_image", targetImageId: t1.id });
    check(out.objectsDeleted === 1, "**删单张目标图只删这一张的 OSS 对象**", `objectsDeleted=${out.objectsDeleted}（应为 1）`);

    const rows = await prisma.targetImage.count({ where: { plan: { userId: user.id } } });
    check(rows === 2, "其余目标图行保留", `剩余 ${rows}`);
    const remainingAssets = await prisma.generatedAsset.findMany({
      where: { userId: user.id }, select: { storageKey: true },
    });
    check(
      remainingAssets.length === 2 && !remainingAssets.some((a) => a.storageKey.endsWith("target-keep-1.png")),
      "**资产台账与保留的行一致**（不留指向已删对象的行）",
      remainingAssets.map((a) => a.storageKey.slice(-18)).join(","),
    );
  }

  // ── ⑤ 撤回人脸同意 / 删全部照片必须级联清人脸派生图 ──
  //
  // 回归：GeneratedAsset 的枚举曾只放在「删生成图/删号」分支里，
  // 于是 all_photos（撤回同意的唯一出口）删掉原图、却把用户人脸的
  // AI 生成图永久留在 OSS 与库中。合规上最不能漏的正是这条路径。
  {
    const user = await prisma.user.create({ data: { deviceSessionId: `${prefix}-e`, ageConfirmed18Plus: true } });
    const plan = await prisma.appearancePlan.create({ data: { userId: user.id, track: "short_term", generationSeed: 5 } });
    // all_photos 是两段式的：请求阶段把照片标 pending，执行阶段才真删。
    // 测试要走同一条路径，否则断言的是一个不存在的调用方式。
    await prisma.userPhoto.create({
      data: {
        userId: user.id, photoType: "front", storageKey: `raw/${user.id}/front.jpg`,
        moderationStatus: "passed", deletionStatus: "pending",
      },
    });
    await assets.record({
      userId: user.id, planId: plan.id, kind: "hairstyle_preview",
      storageKey: `generated/${user.id}/hair-from-face.png`, provider: "stub",
    });

    const out = await deletion.executeDeletion(user.id, { kind: "all_photos" });
    check(
      out.objectsDeleted >= 2,
      "**删全部照片时人脸派生的预览图也被清理**",
      `objectsDeleted=${out.objectsDeleted}（原图 1 + 预览 1）`,
    );
    const leftover = await prisma.generatedAsset.count({ where: { userId: user.id } });
    check(leftover === 0, "人脸派生资产行不残留", `剩余 ${leftover}`);
  }

  console.log(`\n${fail === 0 ? "全部通过" : "有失败项"}：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exitCode = 1;
} finally {
  await prisma.user.deleteMany({ where: { deviceSessionId: { startsWith: prefix } } });
  await prisma.$disconnect();
}
