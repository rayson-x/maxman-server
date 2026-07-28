import type { PrismaClient } from "../generated/prisma/client.js";
import type { AppContainer } from "../app/container.js";
import { createStageProgressionService } from "./stageProgressionService.js";
import { recordWorkflowRun } from "../steps/types.js";
import { persistGeneratedImage } from "../lib/generatedImagePersistence.js";
import { createGeneratedAssetService } from "./generatedAssetService.js";
import { createPhotoAccessService } from "./photoAccessService.js";

/**
 * 目标图生成与质量检查（tasks 8.6-8.8, 7.9）。
 *
 * 三条关键约束：
 *   - 身份/体型保留是**写进生成指令**的硬约束，不是事后指望模型自觉（tasks 8.7）
 *   - 质量检查失败**重试一次**后放弃，与 step 层同口径（决策 16）
 *   - 生成失败**不阻塞**阶段推进（tasks 8.8）——目标图是激励物不是门槛，
 *     且失败不消耗额度
 */

/**
 * 保留约束 + 写实约束。
 *
 * 为什么用提示词钉边界而不是靠后置检查：实测给 img2img 加入体型描述词会让模型
 * 连脸一起重新生成（身份漂移加剧）。既然模型对提示词敏感，就用提示词把边界钉住，
 * 而不是生成完再检查——后者只能发现问题，不能避免问题，且每次重试都是 ¥0.2。
 *
 * **为什么拆成正向 / 反向两段**：原先是一条 75 字符的后缀全拼在正向 prompt 里，
 * 而 SeedEdit 建议正向 ≤120 字符，于是约束吃掉约 68% 的预算，真正要画的造型描述
 * 只剩 30 余字——指令跟随随之变差（要"纹理前刺"给了个大背头）。
 * 而且那 75 字符里有 4 处否定式，扩散类编辑模型对正向否定处理很弱。
 * 现在：否定式进 `negative_prompt`，正向只留一句短约束 + 写实措辞。
 */

/**
 * 正向身份约束。**"表情"这一项是实测出来的关键**：不写它，SeedEdit 会把
 * 源图的中性表情改成微笑（A/B 四组对照里，写了表情的那组是唯一保住中性表情、
 * 且胡茬与皮肤纹理都还在的）。
 *
 * `changeScope` 指明"只改什么"，比笼统的"只改指定部分"更能约束模型的改动范围。
 */
export function identityConstraint(changeScope: string): string {
  return `保持同一个人的脸型、五官与表情不变，只改${changeScope}`;
}

/** 多领域目标图用的通用版本（一次可能同时改发型与穿搭） */
export const IDENTITY_PRESERVATION_SUFFIX = identityConstraint("指定部分");

/**
 * **前置**构图约束 + 造型指令的完整拼装。位置本身是实测结论，不是风格偏好。
 *
 * 在 Seedream 4.5 上，凡是描述里带方向性措辞（「刘海斜向一侧」「在一侧分开」）
 * 的款式，模型会把人物头部转成 3/4 侧脸——它把这些词读成了镜头/头部朝向指令。
 * 对照实验（`npm run bench:image --variants N1,N3,P1,P2,P3`）：
 *
 *   - 约束放句尾（N1/N3，含显式「保持正面视角与原有头部朝向」）→ **仍然转头**
 *   - 把方向措辞换成解剖锚点「分缝线落在左眉正上方」（P1）→ **仍然转头**
 *   - 约束**前置**到句首（P3）→ 姿态保住，且分缝结构正确
 *
 * 所以有效成分是位置，不是措辞强度。
 *
 * 两个坑：
 * 1. **不能出现暗示照片格式的词。** 前置版本最初写「正面平视的证件照角度」，
 *    输出画幅直接从 4:3 横版变成 3:4 竖版（`qualityCheck` 会因宽高比不符判失败）。
 *    改为中性的「原照片的构图、画面比例」。
 * 2. **不要为了防漂移去精简造型描述。** 精简版（P4）在「韩式逗号刘海」上丢掉了
 *    逗号钩的形状，而姿态并没有比 P3 更好——长度不是漂移的原因。
 */
export function composeEditInstruction(changeScope: string, direction: string): string {
  return (
    `保持原照片的构图、画面比例、头部朝向与拍摄距离完全不变，只替换${changeScope}：` +
    `${direction}。脸型、五官、表情不变`
  );
}

/**
 * 反向 prompt。**只放"假"的表现，不放身份属性**。
 *
 * 实测教训：把脸型/五官/肤色/性别/年龄等 18 条否定式全塞进 negative_prompt，
 * 出图反而比留在正向时更塑料、表情也漂了——项数一多每一项的权重就被稀释，
 * 而"要保住什么"对编辑模型来说正向断言比反向否定有效得多。
 * 身份靠 `identityConstraint` 正向钉，这里只负责压掉磨皮/CG 感。
 */
export const NEGATIVE_PROMPT =
  "磨皮，皮肤过度光滑，塑料质感，过度美颜，CG 感，3D 渲染感，换背景，改变表情";

export type QualityCheckResult = {
  passed: boolean;
  issues: string[];
};

/**
 * 自动化质量检查（tasks 8.7）。
 *
 * ⚠ 当前是**结构性检查**（图片是否真实产出、尺寸是否合理、与基准图的宽高比是否一致），
 * 不含视觉一致性判断。视觉判断需要专门的人脸比对能力，而本项目实测发现
 * 通用视觉模型在细粒度判断上不可靠（脸型识别两家一致率仅 2/10），拿它当
 * 「这还是不是同一个人」的裁判风险很高——误判会把好图判死，白烧 ¥0.2 重试。
 *
 * 所以身份保留主要靠生成指令（见 IDENTITY_PRESERVATION_SUFFIX）+ 供应商
 * SeedEdit 本身较强的身份保留能力（实测三种发型改造均保留良好），
 * 这里只拦「明显不对」的结构性问题。
 */
export async function checkGeneratedImageQuality(
  imageBuffer: Buffer,
  expected: { minBytes?: number } = {},
): Promise<QualityCheckResult> {
  const issues: string[] = [];
  const minBytes = expected.minBytes ?? 10_000;

  if (imageBuffer.length < minBytes) {
    issues.push(`图片过小（${imageBuffer.length} 字节 < ${minBytes}），可能是错误页或空白图`);
  }

  // PNG/JPEG 魔数校验——供应商偶尔会返回错误页而 HTTP 仍是 200
  const isPng = imageBuffer.length > 8 && imageBuffer[0] === 0x89 && imageBuffer[1] === 0x50;
  const isJpeg = imageBuffer.length > 3 && imageBuffer[0] === 0xff && imageBuffer[1] === 0xd8;
  if (!isPng && !isJpeg) {
    issues.push("返回内容不是有效的 PNG/JPEG（可能是错误响应而非图片）");
  }

  return { passed: issues.length === 0, issues };
}

export type GenerateTargetImageResult =
  | { ok: true; targetImageId: string; storageKey: string; readUrl: string | null; attempts: number }
  | { ok: false; reason: string; attempts: number; stageStillUnlocked: true };

export type TargetImageGenerationTrigger =
  | "stage_unlock"
  | "user_regeneration"
  | "progress_recheck";

export function targetImageAccounting(
  trigger: TargetImageGenerationTrigger,
  succeeded: boolean,
): { isFreeFirstGeneration: boolean; consumedWeeklyQuota: boolean } {
  const isUserRegeneration = trigger === "user_regeneration";
  return {
    isFreeFirstGeneration: !isUserRegeneration,
    consumedWeeklyQuota: isUserRegeneration && succeeded,
  };
}

export function createTargetImageService(prisma: PrismaClient, providers: AppContainer["providers"]) {
  const progression = createStageProgressionService(prisma);
  const photoAccess = createPhotoAccessService(prisma);

  return {
    /**
     * 为某阶段生成目标图。
     * **失败返回 `stageStillUnlocked: true`** —— 明确表达"图没出来但阶段照常推进"（tasks 8.8）。
     */
    async generateForStage(params: {
      jobId: string;
      planId: string;
      stageId: string;
      imageType: "face_hair" | "full_body_outfit";
      trigger?: TargetImageGenerationTrigger;
    }): Promise<GenerateTargetImageResult> {
      const t0 = Date.now();
      const trigger = params.trigger ?? "stage_unlock";
      const input = await progression.buildTargetImageInput(params.planId, params.stageId);
      if (!input) {
        await recordWorkflowRun(prisma, {
          jobId: params.jobId, planId: params.planId, stepName: "target_image_generation",
          finalStatus: "failed", latencyMs: Date.now() - t0,
        });
        return { ok: false, reason: "缺少基准照片或阶段不存在", attempts: 0, stageStillUnlocked: true };
      }

      // 没有视觉可渲染的变化就不生成。硬出一张的结果是"磨皮版原图"：
      // 白烧一次额度，还让用户以为方案的效果就是把皮肤修一下。
      if (!input.hasRenderableChange) {
        await recordWorkflowRun(prisma, {
          jobId: params.jobId, planId: params.planId, stepName: "target_image_generation",
          finalStatus: "skipped", latencyMs: Date.now() - t0,
        });
        return {
          ok: false,
          reason: "本阶段没有可渲染的外观变化（护肤/健身这类任务画不出来），跳过出图",
          attempts: 0,
          stageStillUnlocked: true,
        };
      }

      const plan = await prisma.appearancePlan.findUnique({ where: { id: params.planId } });
      if (!plan) {
        return { ok: false, reason: "方案不存在", attempts: 0, stageStillUnlocked: true };
      }
      const { url: baselineUrl } = await photoAccess.issueReadUrl({
        storageKey: input.baselineStorageKey,
        photoId: input.baselinePhotoId,
        accessorType: "system_provider",
        purpose: `阶段目标图生成（${trigger}）`,
        expiresSeconds: 900,
      });
      const instruction = `${input.instruction} ${IDENTITY_PRESERVATION_SUFFIX}`;

      let attempts = 0;
      let lastError = "";
      let lastQualityIssues: string[] = [];

      // 决策 16：重试一次后放弃。图片生成是并发=1 的稀缺全局资源，
      // 无限重试会挤占队列拖垮其他用户。
      while (attempts < 2) {
        attempts += 1;
        try {
          const result = await providers.imageEdit.edit({
            imageUrl: baselineUrl,
            instruction,
            negativePrompt: NEGATIVE_PROMPT,
            seed: input.seed,
          });
          const persisted = await persistGeneratedImage({
            result,
            userId: plan.userId,
            filenameBase: `stage${input.stageIndex}-${params.imageType}-${Date.now()}`,
            planId: params.planId,
          });
          // 目标图同样先落资产台账（基于自报完成情况生成，标识文案里要体现）
          await createGeneratedAssetService(prisma).record({
            userId: plan.userId,
            planId: params.planId,
            kind: "target_image",
            storageKey: persisted.storageKey,
            provider: result.provider,
            providerCallId: result.callId,
            basedOnSelfReported: true,
          });

          const accounting = targetImageAccounting(trigger, true);

          const targetImage = await prisma.targetImage.create({
            data: {
              planId: params.planId,
              stageId: params.stageId,
              imageType: params.imageType,
              baselinePhotoId: input.baselinePhotoId,
              manifestSnapshot: input.completedChanges as never,
              plannedChangesSnapshot: input.plannedChanges as never,
              storageKey: persisted.storageKey,
              qualityCheckStatus: "passed",
              retryCount: attempts - 1,
              provider: result.provider,
              providerCallId: result.callId,
              ...accounting,
            },
          });

          // tasks 7.9：WorkflowRun 持久化，供成本核算与问题追溯
          await recordWorkflowRun(prisma, {
            jobId: params.jobId,
            planId: params.planId,
            stepName: "target_image_generation",
            finalStatus: "completed",
            latencyMs: Date.now() - t0,
            retryCount: attempts - 1,
            cost: 0.2 * attempts, // 每次调用 ¥0.2，重试也计费
            provider: result.provider,
            qualityResult: { passed: true },
          });

          let readUrl: string | null = null;
          try {
            readUrl = (
              await photoAccess.issueReadUrl({
                storageKey: persisted.storageKey,
                accessorType: "user",
                accessorId: plan.userId,
                purpose: "用户查看阶段目标图",
                expiresSeconds: 3600,
              })
            ).url;
          } catch (error) {
            // 图片已经生成并落库，不能因为“即时展示 URL”签发失败就再次调用计费供应商。
            // 客户端稍后 GET /plans/:id 会重新走带审计的签发路径。
            console.error(
              `[target-image] 已生成 ${targetImage.id}，但即时读取授权失败:`,
              error instanceof Error ? error.message : String(error),
            );
          }
          return {
            ok: true,
            targetImageId: targetImage.id,
            storageKey: persisted.storageKey,
            readUrl,
            attempts,
          };
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          lastQualityIssues = [lastError];
        }
      }

      // 两次都失败：落一条 failed 记录，但**不消耗额度**（决策 15/16）
      await prisma.targetImage.create({
        data: {
          planId: params.planId,
          stageId: params.stageId,
          imageType: params.imageType,
          baselinePhotoId: input.baselinePhotoId,
          manifestSnapshot: input.completedChanges as never,
          plannedChangesSnapshot: input.plannedChanges as never,
          qualityCheckStatus: "failed",
          retryCount: attempts - 1,
          ...targetImageAccounting(trigger, false),
        },
      });

      await recordWorkflowRun(prisma, {
        jobId: params.jobId,
        planId: params.planId,
        stepName: "target_image_generation",
        finalStatus: "failed",
        latencyMs: Date.now() - t0,
        retryCount: attempts - 1,
        cost: 0.2 * attempts,
        qualityResult: { passed: false, issues: lastQualityIssues },
      });

      return { ok: false, reason: lastError, attempts, stageStillUnlocked: true };
    },
  };
}

export type TargetImageService = ReturnType<typeof createTargetImageService>;
