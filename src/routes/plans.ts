import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../plugins/session.js";
import { createStageProgressionService } from "../services/stageProgressionService.js";
import { createPresignedReadUrl } from "../lib/ossUpload.js";

const statusUpdateSchema = z.object({
  status: z.enum(["pending", "done", "skipped", "blocked", "replaced"]),
});

const selectSchema = z.object({ styleTag: z.string().min(1) });

/**
 * 方案读取与阶段推进路由（tasks 8.1-8.4, 8.9）。
 */
export async function registerPlanRoutes(app: FastifyInstance): Promise<void> {
  const { prisma } = app.container;
  const progression = createStageProgressionService(prisma);

  /**
   * tasks 8.1：一次返回全部四阶段任务。
   * 决策 8 把懒生成改成一次全生成后，这里不再需要「未生成阶段只给骨架」的占位逻辑——
   * 用户从第一天就能看到完整路线图。
   */
  async function loadPlanPayload(planId: string, userId: string) {
    const plan = await prisma.appearancePlan.findFirst({
      where: { id: planId, userId },
      include: {
        stages: {
          orderBy: { stageIndex: "asc" },
          include: { tasks: { orderBy: { sortOrder: "asc" } }, targetImages: true },
        },
      },
    });
    if (!plan) return null;

    return {
      planId: plan.id,
      track: plan.track,
      status: plan.status,
      planVersion: plan.planVersion,
      currentStage: plan.currentStage,
      selectedHairstyleId: plan.selectedHairstyleId,
      selectedOutfitId: plan.selectedOutfitId,
      stages: await Promise.all(
        plan.stages.map(async (stage) => {
          const { coreTotal, coreDone, allCoreDone } = await progression.evaluateStageUnlock(stage.id);
          return {
            stageIndex: stage.stageIndex,
            windowLabel: stage.windowLabel,
            status: stage.status,
            completionPct: stage.completionPct,
            // 解锁进度实时算出，不读缓存字段
            coreProgress: { done: coreDone, total: coreTotal, allDone: allCoreDone },
            targetImages: stage.targetImages.map((img) => ({
              imageType: img.imageType,
              readUrl: img.storageKey ? createPresignedReadUrl(img.storageKey, { expiresSeconds: 3600 }) : null,
              qualityCheckStatus: img.qualityCheckStatus,
              // tasks 8.9：目标图必须带这条标注（决策 13）
              disclosure: "本图基于你勾选的完成情况生成，为模拟效果",
            })),
            tasks: stage.tasks.map((t) => ({
              taskId: t.id,
              domain: t.domain,
              priority: t.priority,
              evidenceBasis: t.evidenceBasis,
              taskType: t.taskType,
              selectionStatus: t.selectionStatus,
              candidateOptions: t.candidateOptions,
              styleTag: t.styleTag,
              title: t.title,
              estTime: t.estTime,
              estCost: t.estCost,
              rationale: t.rationale,
              status: t.status,
              sortOrder: t.sortOrder,
              // 核心任务不可跳过这条规则前端也要知道，避免给出一个点了就报错的按钮
              skippable: t.priority !== "core",
            })),
          };
        }),
      ),
    };
  }

  app.get("/plans/:planId", async (req, reply) => {
    const user = requireUser(req);
    const { planId } = req.params as { planId: string };
    const payload = await loadPlanPayload(planId, user.id);
    if (!payload) return reply.code(404).send({ error: "方案不存在" });
    return reply.send(payload);
  });

  /** tasks 8.1a：客户端不必先知道 plan id */
  app.get("/plans/current", async (req, reply) => {
    const user = requireUser(req);
    const active = await prisma.appearancePlan.findFirst({
      where: { userId: user.id, status: "active" },
      orderBy: { createdAt: "desc" },
    });
    if (!active) return reply.code(404).send({ error: "尚无活跃方案" });
    const payload = await loadPlanPayload(active.id, user.id);
    return reply.send(payload);
  });

  /**
   * 用户从预览候选里选定发型/穿搭（决策 3 的两步约束选择）。
   *
   * 这个端点此前**完全缺失**：`selectedHairstyleId` 只被 `planRevisionService`
   * （换风格，tasks 9.x）写过，而 onboarding 的首次选定没有任何入口。后果是
   * `/outfit-previews` 与 `/materialize` 的「未选发型」校验永远为真，两个端点
   * 恒定 422，整条 onboarding 走不到穿搭那一步。
   *
   * **只接受出现在推荐候选里的 entryId**，不接受任意 id。理由是确定性过滤
   * （脸型适配 + 发际线/发量组合规则，决策 6）存在的意义就是把不合适的挡在外面；
   * 若客户端能提交任意 id，过滤引擎就被绕过了，用户可能选到一个我们明确判断
   * 会暴露发际线问题的发型。候选集以最近一次分析 job 的审计轨迹为准。
   */
  app.post("/plans/:planId/select-style", async (req, reply) => {
    const user = requireUser(req);
    const { planId } = req.params as { planId: string };
    const { entryId, kind } = req.body as { entryId?: string; kind?: string };

    if (!entryId || (kind !== "hairstyle" && kind !== "outfit")) {
      return reply.code(400).send({ error: "需要 entryId 与 kind（hairstyle|outfit）" });
    }

    const plan = await prisma.appearancePlan.findFirst({ where: { id: planId, userId: user.id } });
    if (!plan) return reply.code(404).send({ error: "方案不存在" });

    const entry = await prisma.styleProfileEntry.findUnique({ where: { id: entryId } });
    const expectedKind = kind === "hairstyle" ? "hairstyle" : "outfit_combo";
    if (!entry || entry.kind !== expectedKind) {
      return reply.code(422).send({ error: "style_not_found", message: `未找到该${kind === "hairstyle" ? "发型" : "穿搭"}条目` });
    }

    // 校验它确实是我们推荐过的候选之一
    const job = await prisma.analysisJob.findFirst({
      where: {
        userId: user.id,
        planId,
        jobType: kind === "hairstyle" ? "initial_analysis" : "outfit_preview_generation",
        status: { in: ["completed", "completed_partial"] },
      },
      orderBy: { createdAt: "desc" },
    });
    const pr = (job?.partialResult ?? {}) as {
      recommendation?: { candidates?: { entryId: string }[] };
      outfit?: { previews?: { entryId: string }[] };
    };
    const offered = new Set(
      kind === "hairstyle"
        ? (pr.recommendation?.candidates ?? []).map((c) => c.entryId)
        : (pr.outfit?.previews ?? []).map((c) => c.entryId),
    );
    if (offered.size > 0 && !offered.has(entryId)) {
      return reply.code(422).send({
        error: "not_in_candidates",
        message: "该选项不在为你筛选出的候选中。候选经过脸型与发量适配过滤，直接指定会绕过这层判断。",
        offered: [...offered],
      });
    }

    const updated = await prisma.appearancePlan.update({
      where: { id: planId },
      data: kind === "hairstyle" ? { selectedHairstyleId: entryId } : { selectedOutfitId: entryId },
    });

    // 决策 0.6：只存结构化决策，不存对话原文
    await prisma.conversationDecision.create({
      data: { planId, decisionKind: "style_selected", payload: { kind, entryId, nameZh: entry.nameZh } },
    });

    return reply.send({
      ok: true,
      selectedHairstyleId: updated.selectedHairstyleId,
      selectedOutfitId: updated.selectedOutfitId,
      nameZh: entry.nameZh,
    });
  });

  /** tasks 8.2/8.3：任务状态更新，完成时自动写账本 */
  app.post("/plans/:planId/tasks/:taskId/status", async (req, reply) => {
    const user = requireUser(req);
    const { planId, taskId } = req.params as { planId: string; taskId: string };
    const input = statusUpdateSchema.parse(req.body);

    const plan = await prisma.appearancePlan.findFirst({ where: { id: planId, userId: user.id } });
    if (!plan) return reply.code(404).send({ error: "方案不存在" });

    const result = await progression.updateTaskStatus({ taskId, planId, nextStatus: input.status });
    if (!result.ok) {
      return reply.code(result.code === "task_not_found" ? 404 : 422).send({
        error: result.code,
        message: result.reason,
      });
    }

    // 阶段解锁时触发目标图生成（tasks 7.6）——注意目标图**不阻塞**解锁，
    // 解锁已经在上面完成了，这里只是追加一个生成任务
    if (result.stageUnlocked && result.unlockedStageIndex !== undefined) {
      const nextStage = await prisma.stage.findFirst({
        where: { planId, stageIndex: result.unlockedStageIndex },
      });
      if (nextStage) {
        const job = await prisma.analysisJob.create({
          data: { userId: user.id, planId, stageId: nextStage.id, jobType: "stage_unlock_generation" },
        });
        await app.container.queues.queues["image-generation"].add("stage_unlock_generation", {
          jobId: job.id, userId: user.id, planId, stageId: nextStage.id,
        });
      }
    }

    return reply.send({
      ok: true,
      status: result.status,
      manifestEntryCreated: result.manifestEntryCreated,
      stageUnlocked: result.stageUnlocked,
      unlockedStageIndex: result.unlockedStageIndex,
    });
  });

  /** tasks 8.4：guided_selection 选定 */
  app.post("/plans/:planId/tasks/:taskId/select", async (req, reply) => {
    const user = requireUser(req);
    const { planId, taskId } = req.params as { planId: string; taskId: string };
    const input = selectSchema.parse(req.body);

    const plan = await prisma.appearancePlan.findFirst({ where: { id: planId, userId: user.id } });
    if (!plan) return reply.code(404).send({ error: "方案不存在" });

    const result = await progression.selectOption({ taskId, planId, styleTag: input.styleTag });
    if (!result.ok) return reply.code(422).send({ error: "selection_failed", message: result.reason });

    return reply.send({
      ok: true,
      styleTag: result.styleTag,
      // 明确回给客户端：选定不等于完成
      taskStatus: result.statusUnchanged,
      note: "已记录你选定的方向。等你实际完成之后再标记这个任务为完成。",
    });
  });

  /** 目标图生成输入的调试端点——便于核对决策 4 的口径 */
  app.get("/plans/:planId/stages/:stageIndex/target-image-input", async (req, reply) => {
    const user = requireUser(req);
    const { planId, stageIndex } = req.params as { planId: string; stageIndex: string };
    const plan = await prisma.appearancePlan.findFirst({ where: { id: planId, userId: user.id } });
    if (!plan) return reply.code(404).send({ error: "方案不存在" });
    const stage = await prisma.stage.findFirst({ where: { planId, stageIndex: Number(stageIndex) } });
    if (!stage) return reply.code(404).send({ error: "阶段不存在" });

    const input = await progression.buildTargetImageInput(planId, stage.id);
    if (!input) return reply.code(422).send({ error: "缺少基准照片" });
    return reply.send(input);
  });
}
