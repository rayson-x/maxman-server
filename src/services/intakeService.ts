import type { PrismaClient } from "../generated/prisma/client.js";
import type { BasicQuestionnaireInput, FullQuestionnaireInput } from "../schemas/intake.js";

/**
 * 问卷落库与结构性矛盾校验（tasks 3.3/3.4）。
 */

export type ContradictionIssue = { field: string; message: string };

/**
 * 结构性矛盾校验（tasks 3.4）。
 *
 * 这里查的不是「格式对不对」（那是 zod 的活），而是「几个字段放在一起说不通」。
 * 这类矛盾会污染推荐引擎的输入——例如自报体脂 5% 同时说从不运动，
 * 用它去过滤穿搭会得出荒谬结果，宁可先让用户确认。
 */
export function findContradictions(input: FullQuestionnaireInput): ContradictionIssue[] {
  const issues: ContradictionIssue[] = [];

  if (input.heightCm && input.weightKg) {
    const bmi = input.weightKg / (input.heightCm / 100) ** 2;
    if (bmi < 12 || bmi > 55) {
      issues.push({
        field: "heightCm/weightKg",
        message: `身高体重组合得出的 BMI 为 ${bmi.toFixed(1)}，超出可信范围，请确认填写是否正确`,
      });
    }
  }

  if (input.bodyFatPercent !== undefined && input.bodyFatPercent < 8 && input.exercisesRegularly === false) {
    issues.push({
      field: "bodyFatPercent",
      message: "体脂率低于 8% 通常需要长期系统训练，与「不常运动」不一致，请确认",
    });
  }

  if (input.waistCm && input.chestCm && input.waistCm > input.chestCm + 30) {
    issues.push({ field: "waistCm/chestCm", message: "腰围显著大于胸围，请确认两项没有填反" });
  }

  // 发量自报为 thick 同时勾选脱发困扰：不是硬矛盾（发量多也可能担心脱发），
  // 但会让「发量不够」的强约束逻辑失效，需要提示用户澄清
  if (input.selfReportedHairVolume === "thick" && input.hairLossConcern) {
    issues.push({
      field: "selfReportedHairVolume/hairLossConcern",
      message: "自评发量为「多」但同时勾选了脱发困扰，请确认——这会影响发型推荐的约束判断",
    });
  }

  return issues;
}

export async function saveBasicQuestionnaire(
  prisma: PrismaClient,
  userId: string,
  input: BasicQuestionnaireInput,
): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: {
      birthDate: input.birthDate
        ? new Date(`${input.birthDate}T00:00:00.000Z`)
        : undefined,
      ageConfirmed18Plus: input.ageConfirmed18Plus,
    },
  });

  // 场景落库。此前服务端只收到 track 一个枚举值，细分场景与日期全丢，
  // 导致 Event 表零写入、正式度没有直接信号、时间窗口无从计算。
  if (input.eventType || input.eventDate) {
    await prisma.event.upsert({
      where: { userId },
      create: {
        userId,
        eventType: input.eventType,
        eventDate: input.eventDate ? new Date(`${input.eventDate}T00:00:00.000Z`) : undefined,
      },
      update: {
        eventType: input.eventType,
        eventDate: input.eventDate ? new Date(`${input.eventDate}T00:00:00.000Z`) : undefined,
      },
    });
  }

  // track 必须落库：它是 AppearancePlan 的必填字段，而方案在 worker 的
  // initial_analysis 编排里才创建，那时拿不到本次请求体。
  // 用 upsert：basic 问卷是采集第一步，profile 通常还不存在。
  await prisma.appearanceProfile.upsert({
    where: { userId },
    create: {
      userId,
      track: input.track,
      province: input.province,
      city: input.city,
      domainSelections: [],
    },
    update: {
      track: input.track,
      province: input.province,
      city: input.city,
    },
  });
}

export async function saveFullQuestionnaire(
  prisma: PrismaClient,
  userId: string,
  input: FullQuestionnaireInput,
): Promise<{ contradictions: ContradictionIssue[] }> {
  const contradictions = findContradictions(input);

  const data = {
    heightCm: input.heightCm,
    weightKg: input.weightKg,
    shoulderWidthCm: input.shoulderWidthCm,
    chestCm: input.chestCm,
    waistCm: input.waistCm,
    thighCm: input.thighCm,
    bodyFatPercent: input.bodyFatPercent,
    exercisesRegularly: input.exercisesRegularly,
    changeWillingness: input.changeWillingness,
    wearsGlasses: input.wearsGlasses,
    hasBeard: input.hasBeard,
    selfReportedHairVolume: input.selfReportedHairVolume,
    hairLossConcern: input.hairLossConcern,
    domainSelections: input.domainSelections,
    domainAcceptance: (input.domainAcceptance ?? undefined) as never,
    budgetTier: input.budgetTier,
  };

  await prisma.appearanceProfile.upsert({
    where: { userId },
    create: { userId, ...data },
    update: data,
  });

  return { contradictions };
}

/**
 * tasks 3.7：脸型确认。决策 5——用户修正值优先于客户端计算值。
 *
 * 同时记下**这次确认是针对哪张正面照**。不记的话确认值会永久粘住：
 * 用户换一张照片、测量结果变了，分析仍用旧确认值覆盖，而客户端显示的是新测量，
 * 于是客户端说长脸、agent 说椭圆（实测复现过）。
 */
export async function confirmFaceShape(prisma: PrismaClient, userId: string, faceShape: string): Promise<void> {
  const latestFront = await prisma.userPhoto.findFirst({
    where: { userId, photoType: "front", deletionStatus: "active" },
    orderBy: { uploadedAt: "desc" },
    select: { id: true },
  });
  await prisma.appearanceProfile.upsert({
    where: { userId },
    create: {
      userId,
      domainSelections: [],
      confirmedFaceShape: faceShape,
      confirmedFaceShapePhotoId: latestFront?.id ?? null,
    },
    update: {
      confirmedFaceShape: faceShape,
      confirmedFaceShapePhotoId: latestFront?.id ?? null,
    },
  });
}

/**
 * 从最新的正面照 faceMetrics 里取出客户端算好的脸型分类，连同支撑比值一起返回。
 * 决策 5：给用户确认时必须带上原始比值——「你的脸长/颧骨宽=1.32，属于长脸型」
 * 比「AI 觉得你是长脸」可信得多。
 */
export async function getComputedFaceShape(prisma: PrismaClient, userId: string) {
  const photo = await prisma.userPhoto.findFirst({
    where: { userId, photoType: "front", deletionStatus: "active" },
    orderBy: { uploadedAt: "desc" },
  });
  if (!photo?.faceMetrics) return null;

  const metrics = photo.faceMetrics as {
    classification?: { faceShape?: { value?: string; confidence?: string; evidence?: Record<string, number> } };
  };
  const fs = metrics.classification?.faceShape;
  if (!fs?.value) return null;

  return {
    photoId: photo.id,
    faceShape: fs.value,
    confidence: fs.confidence ?? "low",
    evidence: fs.evidence ?? {},
  };
}
