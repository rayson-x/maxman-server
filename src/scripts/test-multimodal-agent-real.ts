import "dotenv/config";
import { readFileSync } from "node:fs";
import { createPrismaClient } from "../lib/prisma.js";
import { createRecommendationApplication } from "../services/recommendationApplication.js";
import {
  createHairstyleMultimodalAgentProvider,
  createOutfitMultimodalAgentProvider,
} from "../features/appearance-agent/providers/styleRecommendation/multimodalAgentRecommendation.js";
import { uploadBufferToOSS, buildStorageKey } from "../lib/ossUpload.js";

/**
 * 真实多模态调用验收（tasks 9.11）。约 ¥0.02，两次调用。
 *
 * 这是过渡方案的**前提验证**，不是走过场：如果模型产不出合法结构、
 * 或不遵守「不要输出客观属性与完整指令」的约束，那"先用 Agent 顶上"就不成立。
 * 结论如实记录，包括不利结论。
 */

const FIXTURE = "test-fixtures/faces/01-round.jpg";
const prisma = createPrismaClient();
let pass = 0, fail = 0;
const check = (ok: boolean, label: string, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? `  ${detail}` : ""}`);
};

const prefix = `real-agent-${Date.now()}`;
let calls = 0;
try {
  const user = await prisma.user.create({ data: { deviceSessionId: `${prefix}-dev`, ageConfirmed18Plus: true } });
  const plan = await prisma.appearancePlan.create({ data: { userId: user.id, track: "short_term", generationSeed: 11 } });

  const key = buildStorageKey("raw", user.id, `front-${Date.now()}.jpg`);
  await uploadBufferToOSS(key, readFileSync(FIXTURE));
  await prisma.userPhoto.create({
    data: { userId: user.id, photoType: "front", storageKey: key, moderationStatus: "passed" },
  });

  const app = createRecommendationApplication({
    prisma,
    hairstyleProvider: createHairstyleMultimodalAgentProvider(),
    outfitProvider: createOutfitMultimodalAgentProvider(),
  });

  // ── 发型 ──
  console.log("\n── 真实发型推荐调用 ──");
  const t0 = Date.now();
  calls += 1;
  const hair = await app.recommendHairstyles({
    userId: user.id,
    planId: plan.id,
    requestedCount: 3,
    frontPhotoStorageKey: key,
    geometry: { faceShape: "round", confidence: "high", evidence: { widthToHeight: 0.92 } },
    hairSignals: { hairline: "receding", volume: "thin", selfReportedHairLossConcern: true },
    semantics: { current_hairstyle: "短发", hairline_visibility: "visible", glasses: "黑框眼镜" },
    preference: { text: "想剪个碎盖，显得精神一点", normalizedTag: "微碎盖" },
    changeWillingness: "很不满意，想尽快改变",
  });
  const hairMs = Date.now() - t0;

  check(hair.status === "ready", `候选集就绪（${hairMs}ms）`, `status=${hair.status}`);
  check(hair.candidates.length > 0, `产出 ${hair.candidates.length} 个候选`);
  check(hair.capabilityStatus.knowledgeSource === "multimodal_agent", "知识来源标为多模态 Agent");

  for (const c of hair.candidates) {
    const attrs = c.estimatedAttributes;
    console.log(`   · ${c.nameZh}  [${c.verificationStatus}]  ${attrs ? `遮额=${attrs.coversForehead} 发量=${attrs.requiresHairVolume}` : "属性未知"}`);
    console.log(`     ${c.modelRationale.slice(0, 64)}`);
  }

  const verified = hair.candidates.filter((c) => c.verificationStatus === "catalog_verified");
  console.log(`   命中属性表：${verified.length}/${hair.candidates.length}`);
  check(true, `属性表命中率记录在案`, `${verified.length}/${hair.candidates.length}`);

  // 模型是否遵守「不输出客观属性」：命中表的属性来自表，未命中的必须为 null
  const fabricated = hair.candidates.filter((c) => c.verificationStatus === "not_checked" && c.estimatedAttributes !== null);
  check(fabricated.length === 0, "**未命中属性表的候选没有被编造属性**", fabricated.length ? `${fabricated.length} 条` : "");

  const rows = await prisma.recommendationCandidate.findMany({ where: { setId: hair.setId } });
  check(rows.every((r) => /保持这个人的脸型/.test(r.renderInstruction)), "**每条 renderInstruction 都含身份保持后缀**（应用模块构建）");
  check(rows.every((r) => !/背景|身材|体型/.test(r.visualDirection)), "visualDirection 未越界到背景或体型", rows.map((r) => r.visualDirection.slice(0, 20)).join(" | "));
  check(rows.every((r) => !/脱发|秃|症状|诊断/.test(r.modelRationale + r.description)), "无诊断性表述");
  check(new Set(rows.map((r) => r.rank)).size === rows.length, "rank 唯一");

  // ── 穿搭（无全身照 → 纯文字，不签发照片地址）──
  console.log("\n── 真实穿搭推荐调用（无全身照）──");
  const beforeLogs = await prisma.photoAccessLog.count({ where: { accessorId: user.id } });
  const t1 = Date.now();
  calls += 1;
  const outfit = await app.recommendOutfits({
    userId: user.id,
    planId: plan.id,
    requestedCount: 3,
    selectedHairstyleCandidateId: hair.candidates[0]!.candidateId,
    body: { heightCm: 175, weightKg: 68, shoulderWidthCm: 46, waistCm: 78, bodyFatPercent: 18 },
    scene: { eventType: "日常通勤" },
    weather: { seasonTag: "初秋", tempBand: "15-22" },
    budgetTier: "medium",
  });
  const outfitMs = Date.now() - t1;
  const afterLogs = await prisma.photoAccessLog.count({ where: { accessorId: user.id } });

  check(outfit.status === "ready", `穿搭候选集就绪（${outfitMs}ms）`, `status=${outfit.status}`);
  check(outfit.candidates.length > 0, `产出 ${outfit.candidates.length} 个穿搭方向`);
  check(outfit.capabilityStatus.outfitCoordination === "agent_estimated", "协调状态标为 Agent 估计");
  check(afterLogs === beforeLogs, "**无全身照时不签发照片地址**", `${beforeLogs} → ${afterLogs}`);
  for (const c of outfit.candidates) console.log(`   · ${c.nameZh}：${c.description.slice(0, 50)}`);

  console.log(`\n实际调用 ${calls} 次（约 ¥${(calls * 0.01).toFixed(2)}）`);
  console.log(`${fail === 0 ? "全部通过" : "有失败项"}：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exitCode = 1;
} finally {
  await prisma.user.deleteMany({ where: { deviceSessionId: { startsWith: prefix } } });
  await prisma.$disconnect();
}
