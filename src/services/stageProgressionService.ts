import type { PrismaClient } from "../generated/prisma/client.js";
import type { TaskStatus } from "../generated/prisma/enums.js";

/**
 * 阶段推进（tasks 8.2-8.5）。
 *
 * 三条关键规则（design.md 决策 4/14）：
 *   - 核心任务**不可跳过，只可替换**——跳过等于放弃目标，而目标图正是按 core 生成的
 *   - 解锁判定**实时查询**全部 core 任务，不用缓存计数（缓存必然会和真实状态不同步）
 *   - 任务完成 → 自动写 `ChangeManifestEntry`，**不调 LLM**（change_description 在
 *     任务生成时就预写好了，完成时原样复制）
 */

export type StatusUpdateResult =
  | { ok: true; status: TaskStatus; manifestEntryCreated: boolean; stageUnlocked: boolean; unlockedStageIndex?: number }
  | { ok: false; reason: string; code: "core_not_skippable" | "task_not_found" | "invalid_transition" | "selection_required" };

export function createStageProgressionService(prisma: PrismaClient) {
  /**
   * 实时统计某阶段的 core 任务完成情况（tasks 8.5）。
   * 刻意每次查库而不读缓存字段——`Stage.completionPct` 只用于 UI 进度条，
   * 绝不作为解锁依据。缓存计数一旦和 StageTask 真实状态不同步，
   * 会出现"明明没做完却解锁了"或反之，且极难排查。
   */
  async function evaluateStageUnlock(stageId: string): Promise<{ allCoreDone: boolean; coreTotal: number; coreDone: number }> {
    const coreTasks = await prisma.stageTask.findMany({
      where: { stageId, priority: "core" },
      select: { status: true },
    });
    // `replaced` 视为未完成——替换后的等价任务是另一条记录，由它自己的 done 计数
    const coreDone = coreTasks.filter((t) => t.status === "done").length;
    return { allCoreDone: coreTasks.length > 0 && coreDone === coreTasks.length, coreTotal: coreTasks.length, coreDone };
  }

  return {
    evaluateStageUnlock,

    async updateTaskStatus(params: {
      taskId: string;
      planId: string;
      nextStatus: TaskStatus;
    }): Promise<StatusUpdateResult> {
      const task = await prisma.stageTask.findFirst({
        where: { id: params.taskId, stage: { planId: params.planId } },
        include: { stage: true },
      });
      if (!task) return { ok: false, reason: "任务不存在或不属于该方案", code: "task_not_found" };

      // 决策 14：核心任务不可跳过，只可替换。
      // 理由不是"规则如此"——目标图是按 core 任务的计划变化生成的，
      // 跳过一个 core 就让目标图与实际计划脱节了。
      if (task.priority === "core" && params.nextStatus === "skipped") {
        return {
          ok: false,
          reason: "核心任务不能跳过，只能替换成等价的其他方案",
          code: "core_not_skippable",
        };
      }

      // guided_selection 任务未选定就标完成是没有意义的——不知道他到底做了哪个方案，
      // 也就写不出正确的 ChangeManifestEntry
      if (task.taskType === "guided_selection" && params.nextStatus === "done" && task.selectionStatus !== "selected") {
        return {
          ok: false,
          reason: "这个任务需要先选定具体方向，再标记完成",
          code: "selection_required",
        };
      }

      await prisma.stageTask.update({ where: { id: task.id }, data: { status: params.nextStatus } });

      // tasks 8.3：完成即写账本，**无 LLM 调用**。
      // change_description 在任务生成时（S5）就预写好了，这里原样复制。
      let manifestEntryCreated = false;
      if (params.nextStatus === "done" && task.changeDescription) {
        // guided_selection 任务用**选中候选**的 changeDescription，而不是任务级的占位描述
        let description = task.changeDescription;
        if (task.taskType === "guided_selection" && task.styleTag) {
          const opts = (task.candidateOptions ?? []) as { styleTag: string; changeDescription: string }[];
          const chosen = opts.find((o) => o.styleTag === task.styleTag);
          if (chosen) description = chosen.changeDescription;
        }

        await prisma.changeManifestEntry.create({
          data: {
            planId: params.planId,
            stageId: task.stageId,
            sourceTaskId: task.id,
            domain: task.domain,
            changeDescription: description,
            // 决策 13：自报完成默认 unverified，等 progress_recheck 校准
            verificationStatus: "unverified",
          },
        });
        manifestEntryCreated = true;
      }

      // 更新进度条百分比（仅 UI 用，不参与解锁判定）
      const allTasks = await prisma.stageTask.count({ where: { stageId: task.stageId } });
      const doneTasks = await prisma.stageTask.count({ where: { stageId: task.stageId, status: "done" } });
      await prisma.stage.update({
        where: { id: task.stageId },
        data: { completionPct: allTasks > 0 ? Math.round((doneTasks / allTasks) * 100) : 0 },
      });

      // tasks 8.5：解锁判定
      let stageUnlocked = false;
      let unlockedStageIndex: number | undefined;
      if (params.nextStatus === "done") {
        const { allCoreDone } = await evaluateStageUnlock(task.stageId);
        if (allCoreDone && task.stage.status === "active") {
          await prisma.stage.update({ where: { id: task.stageId }, data: { status: "completed" } });
          const next = await prisma.stage.findFirst({
            where: { planId: params.planId, stageIndex: task.stage.stageIndex + 1 },
          });
          if (next) {
            await prisma.stage.update({ where: { id: next.id }, data: { status: "active" } });
            await prisma.appearancePlan.update({
              where: { id: params.planId },
              data: { currentStage: next.stageIndex },
            });
            stageUnlocked = true;
            unlockedStageIndex = next.stageIndex;
          } else {
            // 阶段3 完成 = 整个方案走完
            await prisma.appearancePlan.update({ where: { id: params.planId }, data: { status: "completed" } });
          }
        }
      }

      return { ok: true, status: params.nextStatus, manifestEntryCreated, stageUnlocked, unlockedStageIndex };
    },

    /** tasks 8.4：guided_selection 选定。只改 selectionStatus 与 styleTag，不动 status，不写账本 */
    async selectOption(params: { taskId: string; planId: string; styleTag: string }) {
      const task = await prisma.stageTask.findFirst({
        where: { id: params.taskId, stage: { planId: params.planId } },
      });
      if (!task) return { ok: false as const, reason: "任务不存在" };
      if (task.taskType !== "guided_selection") return { ok: false as const, reason: "该任务不需要选择" };

      const opts = (task.candidateOptions ?? []) as { styleTag: string; changeDescription: string }[];
      if (!opts.some((o) => o.styleTag === params.styleTag)) {
        return { ok: false as const, reason: `${params.styleTag} 不在候选列表内` };
      }

      await prisma.stageTask.update({
        where: { id: task.id },
        // 决策 14：选定只代表**决策完成**，不代表真实变化已发生。
        // status 保持 pending，账本也不写——只有用户真的去做了才写。
        data: { styleTag: params.styleTag, selectionStatus: "selected" },
      });

      return { ok: true as const, styleTag: params.styleTag, statusUnchanged: task.status };
    },

    /**
     * 目标图的生成输入（决策 4，tasks 8.6）。
     *
     * = 基准照片 + **已完成账本** + **本阶段 core 任务的计划变化**
     *
     * 第三项是前一份 spec 缺的关键部分：只用已完成账本的话，阶段刚解锁时
     * 账本里没有本阶段任何条目，目标图会和上阶段结束时一模一样——
     * 用户解锁新阶段却看到没变化的图，"目标"二字就不成立了。
     */
    async buildTargetImageInput(planId: string, stageId: string) {
      const plan = await prisma.appearancePlan.findUnique({ where: { id: planId } });
      if (!plan) return null;

      const stage = await prisma.stage.findUnique({ where: { id: stageId } });
      if (!stage) return null;

      // 基准照片恒为最初上传的正面照，禁止用上一阶段生成图（防身份漂移）
      const baseline = await prisma.userPhoto.findFirst({
        where: { userId: plan.userId, photoType: "front", deletionStatus: "active" },
        orderBy: { uploadedAt: "asc" },
      });
      if (!baseline) return null;

      // 已完成账本：本阶段之前所有阶段的条目（含本阶段已完成的）
      const completedEntries = await prisma.changeManifestEntry.findMany({
        where: { planId, verificationStatus: { not: "rolled_back" } },
        orderBy: { createdAt: "asc" },
      });

      // 本阶段 core 任务的计划变化（尚未完成但已计划）。
      // **只取 core**：core 集合同时定义解锁条件与目标图内容，两者一致；
      // 否则用户跳过/替换 optional 任务就要重算图。
      const coreTasks = await prisma.stageTask.findMany({
        where: { stageId, priority: "core", status: { notIn: ["done", "replaced"] } },
        orderBy: { sortOrder: "asc" },
      });

      const plannedChanges = coreTasks.map((t) => {
        if (t.taskType === "guided_selection" && t.styleTag) {
          const opts = (t.candidateOptions ?? []) as { styleTag: string; changeDescription: string }[];
          return opts.find((o) => o.styleTag === t.styleTag)?.changeDescription ?? t.changeDescription ?? t.title;
        }
        return t.changeDescription ?? t.title;
      });

      return {
        baselinePhotoId: baseline.id,
        baselineStorageKey: baseline.storageKey,
        // 决策 4：per-user 固定 seed，保证四阶段图像是同一个人的连续演变
        seed: plan.generationSeed,
        completedChanges: completedEntries.map((e) => e.changeDescription),
        plannedChanges,
        /** 合并后的指令列表。编号列表格式实测比逗号串联效果更好 */
        instruction: [...completedEntries.map((e) => e.changeDescription), ...plannedChanges]
          .map((c, i) => `${i + 1}.${c}`)
          .join(" "),
        stageIndex: stage.stageIndex,
      };
    },
  };
}

export type StageProgressionService = ReturnType<typeof createStageProgressionService>;
