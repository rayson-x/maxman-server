import { recordWorkflowRun, type Step, type StepContext, type StepDeps } from "./types.js";
import { photoModerationWhere } from "../lib/photoModerationGate.js";
/**
 * 预览的候选输入。`renderInstruction` 已由 `RecommendationApplication` 用固定模板构建
 * 并追加了身份保持后缀——这里不再拼指令，也不该再拼，否则两处会各追加一遍。
 */
export type PreviewCandidate = {
  candidateId: string;
  nameZh: string;
  renderInstruction: string;
  /** 无全身照的降级路径要把理由一起展示，因为那时没有图可看 */
  modelRationale?: string;
};
import { persistGeneratedImage } from "../lib/generatedImagePersistence.js";
import { createGeneratedAssetService } from "../services/generatedAssetService.js";
import { createPhotoAccessService } from "../services/photoAccessService.js";
import { NEGATIVE_PROMPT } from "../services/targetImageService.js";

/**
 * S4 / S4' 效果图生成（tasks 5.6/5.7）。
 *
 * 这一步的形状完全由**供应商并发=1**这个实测硬约束决定（design.md 决策 12）：
 *   - 图片必须串行提交，无法并发（实测 6 并发时 5 个被 code 50430 拒）
 *   - 因此完成顺序恒等于提交顺序 → **提交顺序必须按匹配度降序**，
 *     保证用户看到的第一张就是最推荐的
 *   - 每出一张就落盘 + 回写 job.partialResult，客户端轮询即可增量渲染，
 *     不必等全部完成（决策 12 的渐进式推送）
 *
 * 无全身照时（决策 11）：**不生成**本人穿搭效果图，返回文字方案 + 通用示意图标记。
 * 这不是降级凑数，而是因为实测证明从证件照生成全身照会导致严重身份漂移——
 * 一张脸不像本人的图会直接击穿"看到自己"的核心承诺，不如老实说给不了。
 */

export type RenderPreviewsInput = {
  /** 基准照片的 storageKey。发型预览用正面照，穿搭预览用全身照 */
  baselinePhotoStorageKey: string;
  /** 已按匹配度降序排列的候选。顺序即提交顺序，不要在这里重排 */
  candidates: PreviewCandidate[];
  kind: "hairstyle" | "outfit";
};

export type RenderedPreview = {
  candidateId: string;
  nameZh: string;
  storageKey: string | null;
  /** 短时预签名读取 URL，供客户端展示 */
  readUrl: string | null;
  providerCallId?: string;
  latencyMs: number;
  /** 无全身照时只展示文字/非本人参考，不得冒充本人生成结果。 */
  referenceOnly?: boolean;
  rationale?: string;
};

export type RenderPreviewsOutput = {
  previews: RenderedPreview[];
  /** 全部生成完成的总耗时，用于核对是否符合串行预期 */
  totalMs: number;
};

/** 把已完成的预览增量写回 job.partialResult，客户端轮询即可看到（决策 12） */
async function pushPartial(
  deps: StepDeps,
  ctx: StepContext,
  kind: string,
  previews: RenderedPreview[],
  pending: number,
): Promise<void> {
  const job = await deps.prisma.analysisJob.findUnique({ where: { id: ctx.jobId } });
  const existing = (job?.partialResult ?? {}) as Record<string, unknown>;
  await deps.prisma.analysisJob.update({
    where: { id: ctx.jobId },
    data: {
      partialResult: {
        ...existing,
        [`${kind}Previews`]: previews.map((p) => ({ candidateId: p.candidateId, nameZh: p.nameZh, readUrl: p.readUrl })),
        [`${kind}PreviewsPending`]: pending,
      } as never,
    },
  });
}

export const renderPreviewsStep: Step<RenderPreviewsInput, RenderPreviewsOutput> = {
  name: "S4_render_previews",
  async run(input, ctx, deps) {
    const t0 = Date.now();
    const previews: RenderedPreview[] = [];
    const failures: { item: string; reason: string }[] = [];

    const baselinePhoto = await deps.prisma.userPhoto.findFirst({
      where: {
        userId: ctx.userId,
        storageKey: input.baselinePhotoStorageKey,
        deletionStatus: "active",
        ...photoModerationWhere(),
      },
    });
    if (!baselinePhoto) {
      return { status: "failed", error: "找不到已通过审核的本人基准照片" };
    }
    const photoAccess = createPhotoAccessService(deps.prisma);
    // 供应商需要能抓到输入图 → 短时预签名 URL，并把授权事件写入审计日志。
    const { url: baselineUrl } = await photoAccess.issueReadUrl({
      storageKey: baselinePhoto.storageKey,
      photoId: baselinePhoto.id,
      accessorType: "system_provider",
      purpose: `${input.kind}预览图生成`,
      expiresSeconds: 900,
    });
    const plan = ctx.planId
      ? await deps.prisma.appearancePlan.findUnique({
          where: { id: ctx.planId },
          select: { generationSeed: true },
        })
      : null;

    // ⚠ 串行 for 循环是刻意的，不要改成 Promise.all —— 供应商并发上限为 1，
    // 并发提交会被 code 50430 拒。队列层也配了 concurrency=1 做跨进程保证，
    // 这里的串行是同一约束在 step 内部的体现。
    for (const [index, candidate] of input.candidates.entries()) {
      try {
        const result = await deps.providers.imageEdit.edit({
          imageUrl: baselineUrl,
          instruction: candidate.renderInstruction,
          // 身份/写实的否定式约束走 negative_prompt，不再占正向长度预算
          negativePrompt: NEGATIVE_PROMPT,
          seed: plan?.generationSeed,
        });
        await recordWorkflowRun(deps.prisma, {
          jobId: ctx.jobId,
          planId: ctx.planId,
          stepName: `S4_render_${input.kind}_provider`,
          finalStatus: "completed",
          latencyMs: result.latencyMs,
          provider: result.provider,
        });

        // URL/base64 都走唯一持久化入口：有限下载、格式验证、AI 隐式标识、再写 OSS。
        const safeId = candidate.candidateId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
        const persisted = await persistGeneratedImage({
          result,
          userId: ctx.userId,
          filenameBase: `${input.kind}-${safeId}-${Date.now()}`,
          planId: ctx.planId,
        });
        // 先落资产台账再签发读取地址：删除链路靠它枚举 OSS 对象，
        // 否则这张图从删除路径的视角是孤儿（预览图此前就是这个状态）
        await createGeneratedAssetService(deps.prisma).record({
          userId: ctx.userId,
          planId: ctx.planId,
          kind: input.kind === "hairstyle" ? "hairstyle_preview" : "outfit_preview",
          candidateId: candidate.candidateId,
          storageKey: persisted.storageKey,
          provider: result.provider,
          providerCallId: result.callId,
        });

        let readUrl: string | null = null;
        try {
          readUrl = (
            await photoAccess.issueReadUrl({
              storageKey: persisted.storageKey,
              accessorType: "user",
              accessorId: ctx.userId,
              purpose: `用户查看${input.kind}预览图`,
              expiresSeconds: 3600,
            })
          ).url;
        } catch (error) {
          // 供应商调用与 OSS 持久化已经成功；不要因即时授权日志故障而重复烧图。
          failures.push({
            item: candidate.nameZh,
            reason: `图片已生成，但即时读取授权暂不可用：${error instanceof Error ? error.message : String(error)}`,
          });
        }

        previews.push({
          candidateId: candidate.candidateId,
          nameZh: candidate.nameZh,
          storageKey: persisted.storageKey,
          readUrl,
          providerCallId: result.callId,
          latencyMs: result.latencyMs,
        });

        // 每完成一张立刻推送，用户不必等全部完成（决策 12）
        await pushPartial(deps, ctx, input.kind, previews, input.candidates.length - index - 1);
      } catch (err) {
        failures.push({ item: candidate.nameZh, reason: err instanceof Error ? err.message : String(err) });
      }
    }

    const totalMs = Date.now() - t0;

    if (previews.length === 0) {
      return { status: "failed", error: `全部 ${input.candidates.length} 张预览图生成失败：${failures.map((f) => f.reason).join("; ")}` };
    }

    // 部分成功必须可用**且必须告知**（决策 16）——静默少给一个选项，
    // 用户会以为我们只有这么多方案
    if (failures.length > 0) {
      return { status: "completed_partial", data: { previews, totalMs }, missing: failures };
    }

    return { status: "completed", data: { previews, totalMs } };
  },
};

export type OutfitPreviewInput = {
  /** 全身照。缺失时走降级路径 */
  fullBodyPhotoStorageKey?: string;
  candidates: PreviewCandidate[];
};

export type OutfitPreviewOutput = {
  mode: "personalized" | "text_and_reference_only";
  previews: RenderedPreview[];
  /** 降级模式下给客户端的提示，明确说明为什么没有本人效果图 */
  degradedNotice?: string;
};

/**
 * S4' 穿搭预览（tasks 5.7）。无全身照时降级为文字方案 + 通用示意图。
 */
export const renderOutfitPreviewsStep: Step<OutfitPreviewInput, OutfitPreviewOutput> = {
  name: "S4_render_outfit_previews",
  async run(input, ctx, deps) {
    if (!input.fullBodyPhotoStorageKey) {
      // 决策 11：不从证件照造全身照。实测那样做身份漂移严重，
      // 且加入体型描述词后漂移更甚——一张脸不像本人的图比不给更糟。
      return {
        status: "completed",
        data: {
          mode: "text_and_reference_only",
          previews: input.candidates.map((candidate) => ({
            candidateId: candidate.candidateId,
            nameZh: candidate.nameZh,
            storageKey: null,
            readUrl: null,
            latencyMs: 0,
            referenceOnly: true,
            rationale: candidate.modelRationale,
          })),
          degradedNotice:
            "还没有你的全身照，所以这些穿搭方案先以文字候选呈现，不包含你的本人效果图。" +
            "上传一张已通过审核的全身照，就能看到穿在你身上的模拟效果。",
        },
      };
    }

    const inner = await renderPreviewsStep.run(
      {
        baselinePhotoStorageKey: input.fullBodyPhotoStorageKey,
        candidates: input.candidates,
        kind: "outfit",
      },
      ctx,
      deps,
    );

    if (inner.status === "failed") return inner;
    if (inner.status === "completed_partial") {
      return {
        status: "completed_partial",
        data: { mode: "personalized", previews: inner.data.previews },
        missing: inner.missing,
      };
    }
    return { status: "completed", data: { mode: "personalized", previews: inner.data.previews } };
  },
};
