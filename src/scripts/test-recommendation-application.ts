import "dotenv/config";
import { createPrismaClient } from "../lib/prisma.js";
import {
  createRecommendationApplication,
  type ProviderCandidate,
} from "../services/recommendationApplication.js";

/**
 * 应用模块的零成本验证。替身 provider 计数调用次数，不产生任何供应商费用。
 *
 * 重点验三件事，它们都是「换 provider 实现后必须保持不变」的保护：
 *   1. **抢占先于付费调用** —— 并发请求只触发一次 provider 调用
 *   2. **输出校验在 provider 之外** —— 不合格候选被丢弃而非修补
 *   3. **渲染指令由应用模块构建** —— provider 给不出完整 prompt
 */

const prisma = createPrismaClient();
let pass = 0, fail = 0;
const check = (ok: boolean, label: string, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? `  ${detail}` : ""}`);
};

function candidate(over: Partial<ProviderCandidate> = {}): ProviderCandidate {
  return {
    providerCandidateKey: over.providerCandidateKey ?? "k1",
    nameZh: over.nameZh ?? "微碎盖",
    description: over.description ?? "额前留碎发的短盖头",
    modelRationale: over.modelRationale ?? "额前碎发能弱化脸部横向宽度",
    rank: over.rank ?? 1,
    visualDirection: over.visualDirection ?? "额前留碎发，两侧收干净",
    ...over,
  };
}

/** 计数替身。`delayMs` 用来制造并发窗口 */
function stubProvider(candidates: ProviderCandidate[], opts: { delayMs?: number; version?: string } = {}) {
  const state = { calls: 0 };
  return {
    state,
    provider: {
      name: "stub",
      version: opts.version ?? "v1",
      source: "multimodal_agent" as const,
      async recommend() {
        state.calls += 1;
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        return { candidates };
      },
    },
  };
}

const prefix = `recapp-${Date.now()}`;
try {
  const user = await prisma.user.create({ data: { deviceSessionId: `${prefix}-dev`, ageConfirmed18Plus: true } });
  const plan = await prisma.appearancePlan.create({
    data: {
      userId: user.id,
      track: "short_term",
      generationSeed: 7,
      selectedStyle: { id: "test-style", nameZh: "测试风格", description: "测试", rationale: "测试" },
    },
  });
  const photo = await prisma.userPhoto.create({
    data: { userId: user.id, photoType: "front", storageKey: `raw/${user.id}/front.jpg`, moderationStatus: "passed" },
  });
  const baseCommand = {
    userId: user.id,
    planId: plan.id,
    requestedCount: 3,
    frontPhotoStorageKey: photo.storageKey,
    geometry: { faceShape: "round", confidence: "high", evidence: { widthToHeight: 0.92 } },
    hairSignals: { hairline: "normal", volume: "medium" },
  };

  // ── ① 抢占：并发请求只调一次 provider ──
  {
    const three = [candidate({ providerCandidateKey: "a", nameZh: "微碎盖", rank: 1 }),
                   candidate({ providerCandidateKey: "b", nameZh: "寸头", rank: 2 }),
                   candidate({ providerCandidateKey: "c", nameZh: "纹理烫", rank: 3 })];
    const { state, provider } = stubProvider(three, { delayMs: 200 });
    const app = createRecommendationApplication({ prisma, hairstyleProvider: provider, outfitProvider: provider });

    // 并发 5 个：抢占若失效，provider 会被调多次
    const results = await Promise.all(Array.from({ length: 5 }, () => app.recommendHairstyles(baseCommand)));
    check(state.calls === 1, "**并发 5 个请求只触发一次 provider 调用**", `实际 ${state.calls} 次`);
    check(new Set(results.map((r) => r.setId)).size === 1, "5 个请求收敛到同一个候选集");
    check(results.filter((r) => r.reused).length === 4, "4 个被识别为跟随者", `实际 ${results.filter((r) => r.reused).length}`);

    // 并发命中的可能是快速路径，所以直接验证数据库层的唯一约束确实存在——
    // 它才是抢占的最终保证，快速路径只是降低日志噪音
    const dupKey = `dup-${Date.now()}`;
    await prisma.recommendationSet.create({
      data: { planId: plan.id, kind: "hairstyle", computationKey: dupKey, inputFingerprint: "f",
              source: "multimodal_agent", capabilityStatus: {} as never },
    });
    let conflicted = false;
    try {
      await prisma.recommendationSet.create({
        data: { planId: plan.id, kind: "hairstyle", computationKey: dupKey, inputFingerprint: "f",
                source: "multimodal_agent", capabilityStatus: {} as never },
      });
    } catch (e) { conflicted = (e as { code?: string })?.code === "P2002"; }
    check(conflicted, "**computationKey 的唯一约束在数据库层生效**（抢占的最终保证）");

    const ready = await app.recommendHairstyles(baseCommand);
    check(state.calls === 1, "第三次相同输入复用已就绪集合，不再调用 provider", `累计 ${state.calls} 次`);
    check(ready.candidates.length === 3 && ready.status === "ready", "集合就绪且含 3 个候选");
    check(ready.candidates.map((c) => c.rank).join(",") === "1,2,3", "rank 连续从 1 起");
    check(
      ready.capabilityStatus.knowledgeSource === "multimodal_agent"
        && ready.capabilityStatus.outfitCoordination === "not_checked",
      "能力状态标注：Agent 来源、穿搭协调未校验",
    );
  }

  // ── ①b 客观属性来自服务端表，且不随用户信号变化 ──
  {
    // 「大背头」在属性表里是 coversForehead:false（露额）。
    // provider 自报相反值，断言以表为准。
    const lying = candidate({ providerCandidateKey: "bh", nameZh: "大背头",
      visualDirection: "向后梳起用发胶定型",
      estimatedAttributes: { coversForehead: true, requiresHairVolume: "high" } });
    const unknown = candidate({ providerCandidateKey: "uk", nameZh: "自创飘逸盖", rank: 2,
      visualDirection: "自然垂落的中长层次" });

    for (const [i, signals] of [
      { hairline: "normal", volume: "medium" },
      { hairline: "receding", volume: "thin" },   // 强约束场景，模型最容易迎合的一档
    ].entries()) {
      const { provider } = stubProvider([lying, unknown], { version: `attr-v${i}` });
      const app = createRecommendationApplication({ prisma, hairstyleProvider: provider, outfitProvider: provider });
      const r = await app.recommendHairstyles({ ...baseCommand, hairSignals: signals, requestedCount: 2 });

      const bh = r.candidates.find((c) => c.nameZh === "大背头");
      if (signals.hairline === "normal") {
        // 正常发际线：候选保留，属性以表为准而不是 provider 自报的相反值
        check(bh?.estimatedAttributes?.coversForehead === false,
          `发际线=${signals.hairline} 时「大背头」取表里的露额值（不采信 provider 自报的 true）`,
          `实际 ${JSON.stringify(bh?.estimatedAttributes)}`);
        check(bh?.verificationStatus === "catalog_verified", "命中属性表的候选标为 catalog_verified");
      } else {
        // 发际线偏后：大背头露额（表里 coversForehead:false）且需高发量，
        // 硬约束必须把它剔除。这里断言的是**表值参与了硬性判定**，
        // 而不只是"存到了库里"——首版正是只查表、从不比对 hairSignals，
        // 于是发际线偏后的用户照样收到露额造型，同时被告知"已校验"。
        check(bh === undefined,
          `发际线=${signals.hairline} 时「大背头」被硬约束剔除（露额+需高发量）`,
          bh ? `却仍在结果里：${JSON.stringify(bh.estimatedAttributes)}` : "已剔除");
      }
      const uk = r.candidates.find((c) => c.nameZh === "自创飘逸盖");
      check(uk?.verificationStatus === "not_checked" && uk?.estimatedAttributes === null,
        "未命中属性表的候选标为 not_checked 且不编造属性");
      check(r.capabilityStatus.feasibility === "not_checked",
        "存在未命中项时集合级 feasibility 取最弱档");
    }
  }

  // ── ② 切换 provider 版本后指纹变化，不复用旧集合 ──
  {
    const { state, provider } = stubProvider([candidate({ providerCandidateKey: "z", nameZh: "中分" })], { version: "v2" });
    const app = createRecommendationApplication({ prisma, hairstyleProvider: provider, outfitProvider: provider });
    const r = await app.recommendHairstyles(baseCommand);
    check(state.calls === 1, "**provider 版本变化后重新调用**（指纹含实现版本）", `实际 ${state.calls} 次`);
    check(r.candidates[0]?.nameZh === "中分", "返回的是新实现的候选");
  }

  // ── ③ 输出校验：各类不合格被丢弃 ──
  {
    const bad = [
      candidate({ providerCandidateKey: "dup", nameZh: "A", rank: 1 }),
      candidate({ providerCandidateKey: "dup", nameZh: "B", rank: 2 }),            // key 重复
      candidate({ providerCandidateKey: "n1", nameZh: "A", rank: 3 }),             // 名称重复
      candidate({ providerCandidateKey: "long", nameZh: "C", rank: 4, modelRationale: "很".repeat(500) }), // 超长
      candidate({ providerCandidateKey: "oob", nameZh: "D", rank: 5, visualDirection: "顺便把下颌线削一下" }), // 越界
      candidate({ providerCandidateKey: "ok2", nameZh: "E", rank: 6 }),
      candidate({ providerCandidateKey: "ok3", nameZh: "F", rank: 7 }),
      candidate({ providerCandidateKey: "ok4", nameZh: "G", rank: 8 }),            // 第 4 个合格项，应被数量上限截掉
    ];
    const { provider } = stubProvider(bad, { version: "v3" });
    const app = createRecommendationApplication({ prisma, hairstyleProvider: provider, outfitProvider: provider });
    const r = await app.recommendHairstyles(baseCommand);

    const names = r.candidates.map((c) => c.nameZh);
    check(r.candidates.length === 3, "数量被截到 requestedCount", `实际 ${r.candidates.length}`);
    check(!names.includes("B"), "重复 providerCandidateKey 的候选被丢弃");
    check(names.filter((n) => n === "A").length === 1, "重复名称的候选被丢弃");
    check(!names.includes("C"), "超长文本的候选被丢弃");
    check(!names.includes("D"), "**visualDirection 越界的候选被丢弃**", "「削下颌线」");
    check(r.candidates.map((c) => c.rank).join(",") === "1,2,3", "剩余候选的 rank 被重排为连续");
  }

  // ── ③b 诊断性表述被丢弃，但造型口径的「发际线」放行 ──
  {
    const diagnostic = candidate({ providerCandidateKey: "diag", nameZh: "短寸", rank: 1,
      modelRationale: "对于有轻微脱发困扰的人来说，短寸能保持整洁" });   // 实测模型真的这么写过
    const styling = candidate({ providerCandidateKey: "styl", nameZh: "法式碎盖", rank: 2,
      modelRationale: "额前碎发能自然覆盖发际线位置，显得更精神" });     // 造型口径，必须放行
    const { provider } = stubProvider([diagnostic, styling], { version: "diag-v1" });
    const app = createRecommendationApplication({ prisma, hairstyleProvider: provider, outfitProvider: provider });
    const r = await app.recommendHairstyles({ ...baseCommand, requestedCount: 2 });
    const names = r.candidates.map((c) => c.nameZh);
    check(!names.includes("短寸"), "**含「脱发」的候选被丢弃**（prompt 约束不住，需代码守卫）");
    check(names.includes("法式碎盖"), "**造型口径的「发际线」放行**（那是造型事实不是诊断）");
  }

  // ── ④ 渲染指令由应用模块构建并含身份保持后缀 ──
  {
    const row = await prisma.recommendationCandidate.findFirst({ orderBy: { createdAt: "desc" } });
    check(Boolean(row?.renderInstruction), "候选落库时带 renderInstruction");
    check(/保持这个人的脸型/.test(row?.renderInstruction ?? ""), "**renderInstruction 含身份保持后缀**（provider 未参与构建）");
    check(!/^\s*$/.test(row?.visualDirection ?? " "), "visualDirection 原样保留供审计");
  }

  // ── ⑤ provider 全部不合格时集合置 failed，不产生空的 ready 集合 ──
  {
    const { provider } = stubProvider([candidate({ providerCandidateKey: "x", visualDirection: "把鼻子垫高" })], { version: "v4" });
    const app = createRecommendationApplication({ prisma, hairstyleProvider: provider, outfitProvider: provider });
    const r = await app.recommendHairstyles(baseCommand);
    check(r.status === "failed" && r.candidates.length === 0, "**全部不合格时集合 failed 而非空 ready**", `status=${r.status}`);
  }

  // ── ⑥ selectCandidate 的归属与状态校验 ──
  {
    const readySet = await prisma.recommendationSet.findFirst({
      where: { planId: plan.id, status: "ready" }, include: { candidates: true },
    });
    const cand = readySet!.candidates[0]!;
    const { provider } = stubProvider([], { version: "v5" });
    const app = createRecommendationApplication({ prisma, hairstyleProvider: provider, outfitProvider: provider });

    const ok = await app.selectCandidate({ userId: user.id, planId: plan.id, candidateId: cand.id });
    check(ok.ok === true, "选定就绪集合中的候选成功");
    const updated = await prisma.appearancePlan.findUnique({ where: { id: plan.id } });
    check(updated?.selectedHairstyleId === cand.id, "方案记录了选中的候选 id");

    const otherUser = await prisma.user.create({ data: { deviceSessionId: `${prefix}-other`, ageConfirmed18Plus: true } });
    const notOwned = await app.selectCandidate({ userId: otherUser.id, planId: plan.id, candidateId: cand.id });
    check(notOwned.ok === false && notOwned.reason === "not_owned", "**他人无法选定该候选**");

    const failedSet = await prisma.recommendationSet.findFirst({ where: { planId: plan.id, status: "failed" } });
    if (failedSet) {
      const orphan = await prisma.recommendationCandidate.findFirst({ where: { setId: failedSet.id } });
      check(orphan === null, "failed 集合下没有候选行");
    }
  }

  // ── ⑦ 穿搭：无全身照时不签发照片 URL ──
  {
    const readySet = await prisma.recommendationSet.findFirst({
      where: { planId: plan.id, kind: "hairstyle", status: "ready" }, include: { candidates: true },
    });
    const hair = readySet!.candidates[0]!;
    const before = await prisma.photoAccessLog.count({ where: { accessorId: user.id } });

    const { state, provider } = stubProvider(
      [candidate({ providerCandidateKey: "o1", nameZh: "简约通勤休闲", visualDirection: "纯色针织衫配直筒休闲裤" })],
      { version: "v6" },
    );
    const app = createRecommendationApplication({ prisma, hairstyleProvider: provider, outfitProvider: provider });
    const r = await app.recommendOutfits({
      userId: user.id, planId: plan.id, requestedCount: 3,
      selectedHairstyleCandidateId: hair.id,
      body: { heightCm: 175, shoulderWidthCm: 46, waistCm: 78 },
      scene: { eventType: "日常通勤" },
      weather: { tempBand: "12-18" },
      // 刻意不传 fullBodyPhotoStorageKey
    });
    const after = await prisma.photoAccessLog.count({ where: { accessorId: user.id } });

    check(state.calls === 1, "穿搭 provider 被调用");
    check(r.candidates.length === 1 && r.kind === "outfit", "返回穿搭候选");
    check(after === before, "**无全身照时不签发照片 URL，不产生访问记录**", `${before} → ${after}`);
    check(r.capabilityStatus.outfitCoordination === "agent_estimated", "协调状态标为 Agent 估计（风格向量未就绪）");

    const outfitSet = await prisma.recommendationSet.findUnique({ where: { id: r.setId } });
    check(Boolean(outfitSet?.injectedContext), "注入的场景与天气上下文随集合落库（使推荐事后可解释）");
  }

  console.log(`\n${fail === 0 ? "全部通过" : "有失败项"}：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exitCode = 1;
} finally {
  await prisma.user.deleteMany({ where: { deviceSessionId: { startsWith: prefix } } });
  await prisma.$disconnect();
}
