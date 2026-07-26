import "dotenv/config";
import { createContainer } from "../app/container.js";
import { moderateInputStep } from "../steps/moderateInput.js";
import { analyzeVisionStep } from "../steps/analyzeVision.js";
import { recommendStep } from "../steps/recommend.js";
import { runWithSingleRetry, type StepContext, type StepDeps, type Step } from "../steps/types.js";

/**
 * S1-S3 step 验证。重点不是"能跑通"，而是几条设计约束真的成立：
 *   - S1 红线阻断在确定性层生效，且图片审核缺失被如实标记为部分成功（不假装通过）
 *   - S2 几何来自客户端 faceMetrics，云端只做语义；语义失败时降级而非归零
 *   - S3 确定性过滤在 LLM 之前生效；风格数据未就绪时明确说明而非返回空数组
 *   - 单次重试包装：失败重试一次，不无限重试（图片生成是稀缺全局资源）
 */
const container = createContainer({ withProviders: false, withQueues: false });
const prisma = container.prisma;

let pass = 0, fail = 0;
const check = (ok: boolean, label: string, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? `  ${detail}` : ""}`);
};

try {
  const user = await prisma.user.create({
    data: {
      deviceSessionId: `step-test-${Date.now()}`,
      profile: { create: { domainSelections: ["hair"], hairLossConcern: true, selfReportedHairVolume: "thin", confirmedFaceShape: "oblong" } },
    },
  });
  const photo = await prisma.userPhoto.create({
    data: {
      userId: user.id,
      photoType: "front",
      storageKey: `raw/${user.id}/front.jpg`,
      moderationStatus: "passed",
      faceMetrics: {
        classification: {
          faceShape: { value: "round", confidence: "high", evidence: { lengthWidthRatio: 1.05 } },
          hairline: { value: "receding" },
          hairVolume: { value: "thin" },
        },
      },
    },
  });

  const job = await prisma.analysisJob.create({ data: { userId: user.id, jobType: "initial_analysis" } });
  const ctx: StepContext = { jobId: job.id, userId: user.id };
  const deps: StepDeps = { prisma, providers: container.providers };

  console.log("=== S1 moderate-input ===");
  const s1Blocked = await moderateInputStep.run(
    { texts: ["想剪个碎盖", "把我的下巴削尖"], photoStorageKeys: [photo.storageKey] },
    ctx, deps,
  );
  const s1d = s1Blocked.status !== "failed" ? s1Blocked.data : null;
  check(s1d?.hasBlocked === true, "红线输入被确定性层拦住", s1d?.textVerdicts.find((v) => v.verdict === "blocked")?.category);
  check(s1d?.textVerdicts[0].verdict === "in_domain", "正常输入通过");
  check(s1Blocked.status === "completed_partial", "图片审核缺失如实标为部分成功（不假装通过）", s1Blocked.status);
  check(
    s1Blocked.status === "completed_partial" && s1Blocked.missing.some((m) => m.item.includes("图片审核")),
    "缺口原因写清楚（供应商未选型）",
  );

  console.log("\n=== S2 analyze-vision ===");
  // withProviders:false 时 providers.vision 不存在，正好用来验证语义失败时的降级路径
  const s2 = await analyzeVisionStep.run({ frontPhotoStorageKey: photo.storageKey }, ctx, deps);
  const s2d = s2.status !== "failed" ? s2.data : null;
  check(s2.status === "completed_partial", "云端语义不可用时降级为部分成功（几何仍可用）", s2.status);
  check(s2d?.geometry.source === "client_mediapipe", "几何来自客户端 MediaPipe，不是云端判断", s2d?.geometry.faceShape ?? "");
  check(s2d?.geometry.faceShape === "round", "读到客户端算出的脸型", `faceShape=${s2d?.geometry.faceShape}`);
  check(
    s2d?.hairSignals.hairline === "receding" && s2d?.hairSignals.volume === "thin",
    "发型信号从 faceMetrics 正确提取",
    `hairline=${s2d?.hairSignals.hairline} volume=${s2d?.hairSignals.volume}`,
  );
  check(
    s2d?.hairSignals.selfReportedHairLossConcern === true && s2d?.hairSignals.selfReportedVolume === "thin",
    "自报信号从 profile 合并进来（决策 6 的交叉验证输入）",
  );

  console.log("\n=== S3 recommend（风格数据未就绪）===");
  const s3empty = await recommendStep.run({ vision: s2d! }, ctx, deps);
  const s3ed = s3empty.status !== "failed" ? s3empty.data : null;
  check(s3empty.status === "completed_partial", "数据未就绪时返回部分成功", s3empty.status);
  check(s3ed?.dataReady === false, "明确标记 dataReady=false（不用空数组假装「没有合适的」）");
  check(s3ed?.hairConstraint.strength === "strong", "发型约束仍被算出（后移+薄 → 强约束）", s3ed?.hairConstraint.strength);

  console.log("\n=== S3 recommend（注入风格数据后）===");
  const mk = (id: string, name: string, v: [number, number, number, number], f: number, m: number, vol: "low" | "medium" | "high", covers: boolean, shapes: string[]) =>
    prisma.styleProfileEntry.create({
      data: {
        id, kind: "hairstyle", nameZh: name, aliases: [],
        formality: v[0], maturity: v[1], boldness: v[2], upkeep: v[3],
        femaleAppealScore: f, femaleAppealSource: "fixture", femaleAppealConfidence: "low", femaleAppealRationale: `${name} 的女性视角理由`,
        maleSelfAppealScore: m, maleSelfAppealSource: "fixture", maleSelfAppealConfidence: "low", maleSelfAppealRationale: `${name} 的自身审美理由`,
        requiresHairVolume: vol, coversForehead: covers,
        suitableFaceShapes: shapes, suitableBodyTypes: [], suitableScenes: [],
      },
    });

  await mk("t-texture", "纹理烫", [4, 5, 6, 8], 8, 9, "high", true, ["round", "oblong"]);
  await mk("t-buzz", "寸头", [2, 4, 2, 1], 7, 5, "low", true, ["round", "square"]);
  await mk("t-slick", "大背头", [9, 8, 5, 7], 5, 7, "low", false, ["round", "oblong"]);
  await mk("t-crop", "微碎盖", [3, 3, 4, 4], 9, 8, "medium", true, ["round"]);
  await mk("t-long", "中长发", [4, 5, 5, 5], 6, 6, "medium", true, ["square"]);

  const s3 = await recommendStep.run({ vision: s2d!, hairstyleCandidateCount: 3 }, ctx, deps);
  const s3d = s3.status !== "failed" ? s3.data : null;
  const trace = s3d!.filterTrace;
  console.log(`  过滤轨迹：全部 ${trace.totalHairstyles} → 脸型适配 ${trace.afterFaceShapeFilter} → 发型约束 ${trace.afterHairConstraint}`);
  for (const e of trace.excludedByHairConstraint) console.log(`    ✗ ${e.id} — ${e.reason}`);

  check(s3.status === "completed" && s3d?.dataReady === true, "数据就绪后正常完成");
  check(trace.afterFaceShapeFilter === 4, "脸型过滤生效（中长发只适配 square，被排除）", `${trace.afterFaceShapeFilter}/5`);
  const excludedIds = trace.excludedByHairConstraint.map((e) => e.id);
  check(excludedIds.includes("t-texture"), "强约束排除高发量需求的纹理烫");
  check(excludedIds.includes("t-slick"), "强约束排除露额的大背头");
  check(trace.afterHairConstraint === 2, "最终只剩 2 个合规候选", `寸头/微碎盖`);

  const names = s3d!.hairstyleCandidates.map((c) => c.nameZh);
  check(!names.includes("纹理烫") && !names.includes("大背头"), "被确定性过滤掉的候选不会出现在结果里（LLM 无机会推荐它们）");
  check(
    s3d!.hairstyleCandidates.every((c, i, arr) => i === 0 || arr[i - 1].weightedScore >= c.weightedScore),
    "排序由固定加权公式给出（降序）",
    s3d!.hairstyleCandidates.map((c) => `${c.nameZh}:${c.weightedScore.toFixed(1)}`).join(" > "),
  );

  console.log("\n=== 用户意向评估 ===");
  const withPref = await recommendStep.run({ vision: s2d!, userPreferenceText: "想要韩系锁骨微卷", userPreferenceStyleTag: null }, ctx, deps);
  const wpd = withPref.status !== "failed" ? withPref.data : null;
  check(wpd?.userPreferenceAssessment?.labelAsUserSpecified === true, "未命中目录的意向被标注为「用户指定方向」");
  const inCat = await recommendStep.run({ vision: s2d!, userPreferenceText: "想要微碎盖", userPreferenceStyleTag: "微碎盖" }, ctx, deps);
  const icd = inCat.status !== "failed" ? inCat.data : null;
  check(icd?.userPreferenceAssessment?.inCatalog === true && icd?.userPreferenceAssessment?.appealGapVsRecommended !== undefined,
    "命中目录的意向带上双审美落差（让用户看到「你想要的 vs 数据怎么说」）",
    `落差=${icd?.userPreferenceAssessment?.appealGapVsRecommended}`);

  console.log("\n=== 单次重试包装 ===");
  let calls = 0;
  const flaky: Step<void, string> = {
    name: "flaky",
    async run() {
      calls += 1;
      if (calls === 1) throw new Error("第一次故意失败");
      return { status: "completed", data: "第二次成功" };
    },
  };
  const retried = await runWithSingleRetry(flaky, undefined, ctx, deps);
  check(retried.status === "completed" && retried.attempts === 2, "失败后重试一次并成功", `attempts=${retried.attempts}`);

  calls = 0;
  const alwaysFail: Step<void, string> = { name: "always", async run() { calls += 1; throw new Error("永远失败"); } };
  const gaveUp = await runWithSingleRetry(alwaysFail, undefined, ctx, deps);
  check(gaveUp.status === "failed" && gaveUp.attempts === 2 && calls === 2, "两次都失败则放弃，不无限重试（图片生成是稀缺全局资源）", `调用 ${calls} 次`);

  // 清理
  await prisma.styleProfileEntry.deleteMany({ where: { id: { startsWith: "t-" } } });
  await prisma.user.delete({ where: { id: user.id } });

  console.log(`\n${fail === 0 ? "全部通过" : "有失败项"}：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exit(1);
} finally {
  await prisma.$disconnect();
}
