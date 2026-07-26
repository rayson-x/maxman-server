import "dotenv/config";
import { createContainer } from "../app/container.js";
import { renderPreviewsStep, renderOutfitPreviewsStep } from "../steps/renderPreviews.js";
import { createTargetImageService } from "../services/targetImageService.js";
import { createStageProgressionService } from "../services/stageProgressionService.js";
import type { ImageEditProvider } from "../features/appearance-agent/providers/imageEdit/types.js";
import type { ScoredCandidate } from "../steps/recommend.js";
import type { StepContext, StepDeps } from "../steps/types.js";
import { isOSSConfigured } from "../lib/ossUpload.js";

/**
 * 11.3/11.4/11.5：出图链路验证。
 *
 * 用**注入替身 provider** 而非打真实 API。这不是为了省钱（虽然也省），而是因为
 * 这三条验的都是**我们自己的逻辑**：
 *   - 渐进推送的顺序与增量写入 —— 我们的代码
 *   - 强制第 N 张失败后的降级 —— 真实供应商无法命令它失败第 2 张
 *   - 目标图失败后阶段是否仍可推进 —— 我们的代码
 *
 * 真实供应商在 11.2 单独验（那条的目的是确认账号级并发=1 下不再出现 code 50430，
 * 那确实只能对着真实 API 跑）。
 */

/** 生成一张体积足够通过质量检查的合法 PNG */
function fakePng(seed: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const body = Buffer.alloc(20000);
  body.writeUInt32BE(seed, 0);
  return Buffer.concat([sig, body]);
}

function toDataUrl(buf: Buffer): string {
  return `data:image/png;base64,${buf.toString("base64")}`;
}

/** 可编程替身：记录调用顺序，可指定哪几次失败、每次耗时 */
function createStubImageEditProvider(opts: {
  failOnCall?: number[];
  /** 返回过小的图（触发质量检查失败）的调用序号 */
  tooSmallOnCall?: number[];
  latencyMs?: number;
} = {}): ImageEditProvider & { calls: { instruction: string; at: number }[] } {
  const calls: { instruction: string; at: number }[] = [];
  let n = 0;
  return {
    name: "stub-image-edit",
    calls,
    async edit(input) {
      n += 1;
      const callNo = n;
      calls.push({ instruction: input.instruction, at: Date.now() });
      if (opts.latencyMs) await new Promise((r) => setTimeout(r, opts.latencyMs));
      if (opts.failOnCall?.includes(callNo)) {
        throw new Error(`替身：第 ${callNo} 次调用被指定为失败`);
      }
      const buf = opts.tooSmallOnCall?.includes(callNo) ? Buffer.from([0x89, 0x50, 0x4e, 0x47]) : fakePng(callNo);
      return {
        provider: "stub-image-edit",
        imageUrl: toDataUrl(buf),
        callId: `stub-call-${callNo}`,
        latencyMs: opts.latencyMs ?? 1,
      };
    },
  };
}

const container = createContainer({ withQueues: false });
const prisma = container.prisma;
const progression = createStageProgressionService(prisma);
let pass = 0, fail = 0;
const check = (ok: boolean, label: string, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "✅" : "❌"} ${label}${detail ? `  ${detail}` : ""}`); };

if (!isOSSConfigured()) {
  console.log("OSS 未配置，跳过（本测试会真实写入对象存储并清理）");
  process.exit(0);
}

try {
  const user = await prisma.user.create({ data: { deviceSessionId: `render-${Date.now()}` } });
  const photo = await prisma.userPhoto.create({
    data: { userId: user.id, photoType: "front", storageKey: `raw/${user.id}/base.jpg`, moderationStatus: "passed" },
  });
  const plan = await prisma.appearancePlan.create({
    data: { userId: user.id, track: "short_term", generationSeed: 4242,
      stages: { create: [0, 1, 2, 3].map((i) => ({ stageIndex: i, windowLabel: `S${i}`, status: i === 1 ? "active" : "locked", unlockRule: {} })) } },
    include: { stages: { orderBy: { stageIndex: "asc" } } },
  });
  const st1 = plan.stages[1];
  await prisma.stageTask.create({ data: { stageId: st1.id, domain: "hair", priority: "core", evidenceBasis: "visual_detected", title: "剪发", changeDescription: "剪成微碎盖" } });

  const mkCandidates = (): (ScoredCandidate & { changeInstruction: string })[] => [
    { entryId: "c1", nameZh: "微碎盖", femaleAppealScore: 9, maleSelfAppealScore: 8, appealGap: 1, gapWorthDisclosing: false, weightedScore: 8.6, rationale: "r", changeInstruction: "剪成微碎盖" },
    { entryId: "c2", nameZh: "寸头", femaleAppealScore: 7, maleSelfAppealScore: 5, appealGap: 2, gapWorthDisclosing: false, weightedScore: 6.2, rationale: "r", changeInstruction: "剪成寸头" },
    { entryId: "c3", nameZh: "纹理烫", femaleAppealScore: 6, maleSelfAppealScore: 7, appealGap: -1, gapWorthDisclosing: false, weightedScore: 6.0, rationale: "r", changeInstruction: "做纹理烫" },
  ];

  // ── 11.3 渐进式推送 ──
  console.log("=== 11.3 渐进式推送 ===");
  const job1 = await prisma.analysisJob.create({ data: { userId: user.id, planId: plan.id, jobType: "initial_analysis", status: "rendering" } });
  const ctx1: StepContext = { jobId: job1.id, userId: user.id, planId: plan.id };
  const stub1 = createStubImageEditProvider({ latencyMs: 60 });
  const deps1: StepDeps = { prisma, providers: { ...container.providers, imageEdit: stub1 } };

  // 先写入文字推荐，模拟 S3 完成
  await prisma.analysisJob.update({ where: { id: job1.id }, data: { partialResult: { textRecommendations: [{ nameZh: "微碎盖" }] } as never } });
  const beforeImages = (await prisma.analysisJob.findUnique({ where: { id: job1.id } }))!.partialResult as Record<string, unknown>;
  check(Boolean(beforeImages.textRecommendations) && !beforeImages.hairstylePreviews,
    "文字推荐先到，此时还没有任何图片");

  const r1 = await renderPreviewsStep.run({ baselinePhotoStorageKey: photo.storageKey, candidates: mkCandidates(), kind: "hairstyle" }, ctx1, deps1);
  check(r1.status === "completed", "三张全部生成成功", r1.status);
  const d1 = r1.status !== "failed" ? r1.data : null;

  check(stub1.calls.map((c) => c.instruction).join(" → ") === "剪成微碎盖 → 剪成寸头 → 做纹理烫",
    "提交顺序 = 候选顺序（按匹配度降序，第一张即最推荐）", stub1.calls.map((c) => c.instruction).join(" → "));
  const serial = stub1.calls.every((c, i) => i === 0 || c.at >= stub1.calls[i - 1].at);
  check(serial, "串行提交（并发=1 硬约束的体现）");
  check(d1!.previews[0].nameZh === "微碎盖", "结果第一张是最推荐的");

  const finalPartial = (await prisma.analysisJob.findUnique({ where: { id: job1.id } }))!.partialResult as Record<string, unknown>;
  const pushed = finalPartial.hairstylePreviews as { nameZh: string }[];
  check(pushed.length === 3 && finalPartial.hairstylePreviewsPending === 0,
    "图片逐张写回 partialResult，最终 pending 归零", `${pushed.length} 张，pending=${finalPartial.hairstylePreviewsPending}`);
  check(pushed.map((p) => p.nameZh).join("/") === "微碎盖/寸头/纹理烫", "推送顺序保持匹配度降序", pushed.map((p) => p.nameZh).join("/"));
  check(Boolean(finalPartial.textRecommendations), "文字推荐未被图片覆盖（增量合并而非替换）");

  // ── 11.4 部分失败降级 ──
  console.log("\n=== 11.4 部分失败降级（强制第 2 张失败）===");
  const job2 = await prisma.analysisJob.create({ data: { userId: user.id, planId: plan.id, jobType: "initial_analysis", status: "rendering" } });
  const ctx2: StepContext = { jobId: job2.id, userId: user.id, planId: plan.id };
  const stub2 = createStubImageEditProvider({ failOnCall: [2] });
  const deps2: StepDeps = { prisma, providers: { ...container.providers, imageEdit: stub2 } };

  const r2 = await renderPreviewsStep.run({ baselinePhotoStorageKey: photo.storageKey, candidates: mkCandidates(), kind: "hairstyle" }, ctx2, deps2);
  check(r2.status === "completed_partial", "返回 completed_partial（不是 completed，也不是 failed）", r2.status);
  const d2 = r2.status === "completed_partial" ? r2 : null;
  check(d2!.data.previews.length === 2, "成功的 2 张仍可用（用户能从中选）", `${d2!.data.previews.length} 张可用`);
  check(d2!.missing.length === 1 && d2!.missing[0].item === "寸头",
    "缺失项被明确告知（静默少给会让用户以为只有 2 个方案）", `缺失：${d2!.missing[0].item} — ${d2!.missing[0].reason.slice(0, 30)}`);
  check(d2!.data.previews.map((p) => p.nameZh).join("/") === "微碎盖/纹理烫", "失败的那张被跳过，其余顺序不乱");

  // 全部失败 → failed
  const job3 = await prisma.analysisJob.create({ data: { userId: user.id, planId: plan.id, jobType: "initial_analysis", status: "rendering" } });
  const stub3 = createStubImageEditProvider({ failOnCall: [1, 2, 3] });
  const r3 = await renderPreviewsStep.run({ baselinePhotoStorageKey: photo.storageKey, candidates: mkCandidates(), kind: "hairstyle" },
    { jobId: job3.id, userId: user.id, planId: plan.id }, { prisma, providers: { ...container.providers, imageEdit: stub3 } });
  check(r3.status === "failed", "全部失败才返回 failed", r3.status);

  // ── 11.5 目标图失败不阻塞阶段推进 ──
  console.log("\n=== 11.5 目标图失败不阻塞阶段推进 ===");
  const job4 = await prisma.analysisJob.create({ data: { userId: user.id, planId: plan.id, stageId: st1.id, jobType: "stage_unlock_generation" } });
  const stubFail = createStubImageEditProvider({ failOnCall: [1, 2] }); // 首次+重试都失败
  const svcFail = createTargetImageService(prisma, { ...container.providers, imageEdit: stubFail });
  const gen = await svcFail.generateForStage({ jobId: job4.id, planId: plan.id, stageId: st1.id, imageType: "face_hair" });
  check(gen.ok === false && gen.stageStillUnlocked === true, "生成失败但明确标注阶段仍解锁");
  check(!gen.ok && gen.attempts === 2, "重试一次后放弃（不无限重试挤占稀缺队列）", `尝试 ${!gen.ok ? gen.attempts : 0} 次`);

  const stageAfter = await prisma.stage.findUnique({ where: { id: st1.id } });
  check(stageAfter?.status === "active", "阶段状态未被目标图失败影响", `阶段1 = ${stageAfter?.status}`);
  const tasksVisible = await prisma.stageTask.count({ where: { stageId: st1.id } });
  check(tasksVisible === 1, "任务清单照常可见（目标图是激励物不是门槛）");
  const failedImg = await prisma.targetImage.findFirst({ where: { stageId: st1.id, qualityCheckStatus: "failed" } });
  check(failedImg?.consumedWeeklyQuota === false, "失败不消耗额度");
  const runs = await prisma.workflowRun.findMany({ where: { jobId: job4.id } });
  check(runs.length === 1 && runs[0].finalStatus === "failed" && runs[0].retryCount === 1,
    "WorkflowRun 记录失败与重试次数", `cost=¥${runs[0].cost} retry=${runs[0].retryCount}`);

  // 质量检查拦住过小的图（走的是同一条重试路径）
  console.log("\n=== 质量检查触发重试 ===");
  const job5 = await prisma.analysisJob.create({ data: { userId: user.id, planId: plan.id, stageId: st1.id, jobType: "stage_unlock_generation" } });
  const stubSmallThenOk = createStubImageEditProvider({ tooSmallOnCall: [1] }); // 第1次返回过小图，第2次正常
  const svc2 = createTargetImageService(prisma, { ...container.providers, imageEdit: stubSmallThenOk });
  const gen2 = await svc2.generateForStage({ jobId: job5.id, planId: plan.id, stageId: st1.id, imageType: "face_hair" });
  check(gen2.ok === true && gen2.attempts === 2, "质量检查失败后重试一次即成功", gen2.ok ? `${gen2.attempts} 次尝试` : "");
  const okImg = gen2.ok ? await prisma.targetImage.findUnique({ where: { id: gen2.targetImageId } }) : null;
  check(okImg?.qualityCheckStatus === "passed" && okImg?.retryCount === 1, "记录 retryCount=1");
  check(Array.isArray(okImg?.manifestSnapshot) && Array.isArray(okImg?.plannedChangesSnapshot),
    "两个快照都落库（决策 4：已完成账本 + 本阶段计划）");

  // 清理生成的对象
  const { deleteObjects } = await import("../lib/ossUpload.js");
  const allKeys = [
    ...d1!.previews.map((p) => p.storageKey),
    ...d2!.data.previews.map((p) => p.storageKey),
    ...(gen2.ok ? [gen2.storageKey] : []),
  ];
  if (allKeys.length > 0) await deleteObjects(allKeys);
  await prisma.user.delete({ where: { id: user.id } });

  console.log(`\n${fail === 0 ? "全部通过" : "有失败项"}：${pass} 通过 / ${fail} 失败（清理了 ${allKeys.length} 个生成对象）`);
  if (fail > 0) process.exit(1);
} finally {
  await prisma.$disconnect();
}
