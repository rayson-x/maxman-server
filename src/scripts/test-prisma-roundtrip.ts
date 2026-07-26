import "dotenv/config";
import { createPrismaClient } from "../lib/prisma.js";

/**
 * 验证 Prisma 客户端能真正读写，并且几个关键设计决策在 schema 层面成立：
 *   - 决策 4：AppearancePlan.generationSeed 必填（per-user 固定 seed）
 *   - 决策 4：TargetImage 同时持有 manifestSnapshot 与 plannedChangesSnapshot
 *   - 决策 11：guided_selection 的候选带各自的 changeDescription
 *   - 级联删除：删 User 应清掉其全部关联数据
 */
const prisma = createPrismaClient();

try {
  const sessionId = `test-session-${Date.now()}`;

  const user = await prisma.user.create({
    data: {
      deviceSessionId: sessionId,
      ageConfirmed18Plus: true,
      profile: {
        create: {
          heightCm: 175,
          weightKg: 68,
          exercisesRegularly: false,
          selfReportedHairVolume: "medium",
          hairLossConcern: false,
          budgetTier: "low",
          domainSelections: ["hair", "outfit"],
          confirmedFaceShape: "oblong",
        },
      },
    },
    include: { profile: true },
  });
  console.log(`✅ User + Profile 创建成功  faceShape=${user.profile?.confirmedFaceShape} 发量自报=${user.profile?.selfReportedHairVolume}`);

  const photo = await prisma.userPhoto.create({
    data: {
      userId: user.id,
      photoType: "front",
      storageKey: "raw/test-front.jpg",
      moderationStatus: "passed",
      faceMetrics: {
        schemaVersion: 1,
        engine: "mediapipe-face-landmarker",
        classification: { faceShape: { value: "oblong", confidence: "high", evidence: { lengthWidthRatio: 1.32 } } },
      },
    },
  });
  console.log(`✅ UserPhoto + faceMetrics 落库成功`);

  const plan = await prisma.appearancePlan.create({
    data: {
      userId: user.id,
      track: "short_term",
      // 决策 4：seed 必填，保证四阶段图像连贯
      generationSeed: 20260726,
      femaleAppealWeight: 0.8,
      stages: {
        create: [0, 1, 2, 3].map((i) => ({
          stageIndex: i,
          windowLabel: ["当天10-30分钟", "1-7天", "2-4周", "6-12周"][i],
          status: i === 0 ? "active" : "locked",
          unlockRule: { require_all_core_tasks: true },
        })),
      },
    },
    include: { stages: { orderBy: { stageIndex: "asc" } } },
  });
  console.log(`✅ AppearancePlan + 4 个 Stage 创建成功  seed=${plan.generationSeed} 女性视角权重=${plan.femaleAppealWeight}`);

  const stage1 = plan.stages[1];
  const guidedTask = await prisma.stageTask.create({
    data: {
      stageId: stage1.id,
      domain: "hair",
      priority: "core",
      evidenceBasis: "visual_detected",
      taskType: "guided_selection",
      selectionStatus: "pending_selection",
      title: "换一个适合你脸型的发型",
      // 决策 11：每个候选带自己的 changeDescription，不是裸 tag 数组
      candidateOptions: [
        { styleTag: "微碎盖", changeDescription: "把头发剪成微碎盖，前额留碎发遮盖发际线" },
        { styleTag: "寸头", changeDescription: "把头发剪成清爽寸头" },
      ],
      sortOrder: 1,
    },
  });
  const opts = guidedTask.candidateOptions as { styleTag: string; changeDescription: string }[];
  console.log(`✅ guided_selection 任务创建成功  ${opts.length} 个候选，各带 changeDescription：`);
  for (const o of opts) console.log(`     · ${o.styleTag} → "${o.changeDescription}"`);

  const targetImage = await prisma.targetImage.create({
    data: {
      planId: plan.id,
      stageId: stage1.id,
      imageType: "face_hair",
      baselinePhotoId: photo.id,
      // 决策 4：两个快照并存 —— 已完成账本 + 本阶段 core 计划变化
      manifestSnapshot: [{ changeDescription: "剃干净胡须" }],
      plannedChangesSnapshot: [{ changeDescription: "把头发剪成微碎盖，前额留碎发遮盖发际线" }],
      consumedWeeklyQuota: false,
      provider: "volcengine-jimeng-image-edit",
      providerCallId: "13422742818729952965",
    },
  });
  console.log(`✅ TargetImage 创建成功，manifestSnapshot 与 plannedChangesSnapshot 并存（决策 4 的核心）`);

  await prisma.providerCallLog.create({
    data: {
      callId: `test-call-${Date.now()}`,
      provider: "volcengine",
      reqKey: "seededit_v3.0",
      purpose: "image-edit",
      status: "done",
      resultUrls: ["https://example.invalid/result.png"],
      costEstimate: 0.2,
    },
  });
  console.log(`✅ ProviderCallLog 落库成功（taskLedger 的 Postgres 版）`);

  // 级联删除
  const before = await prisma.stageTask.count({ where: { stage: { planId: plan.id } } });
  await prisma.user.delete({ where: { id: user.id } });
  const afterTasks = await prisma.stageTask.count({ where: { stage: { planId: plan.id } } });
  const afterPlan = await prisma.appearancePlan.count({ where: { id: plan.id } });
  const afterImage = await prisma.targetImage.count({ where: { id: targetImage.id } });
  console.log(
    `✅ 级联删除验证：删 User 前 StageTask=${before}，删后 StageTask=${afterTasks} Plan=${afterPlan} TargetImage=${afterImage}（应全为 0）`,
  );

  if (afterTasks !== 0 || afterPlan !== 0 || afterImage !== 0) {
    console.log("❌ 级联删除不完整");
    process.exit(1);
  }

  console.log("\n全部通过。");
} finally {
  await prisma.$disconnect();
}
