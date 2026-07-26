import type { PrismaClient } from "../generated/prisma/client.js";
import type { AppContainer } from "../app/container.js";

/**
 * Step 契约（design.md 决策 1，tasks 5.9）。
 *
 * 每个 step 必须是**可独立调用、可独立重试**的单元——这不是洁癖，是两个入口
 * 共享一份实现的前提：固定管道按顺序串 step，对话 agent 按需单独调其中一部分。
 * 若 step 之间有隐式顺序耦合（比如靠共享可变状态传递），agent 就没法"只重跑出图"。
 *
 * 因此 step 的签名刻意做成纯函数形态：所有输入显式传入，依赖显式注入，
 * 不读全局单例、不依赖调用顺序之外的隐含前置条件。
 */

export type StepDeps = {
  prisma: PrismaClient;
  providers: AppContainer["providers"];
};

export type StepContext = {
  /** 关联的 AnalysisJob，用于写 WorkflowRun 审计与部分结果 */
  jobId: string;
  userId: string;
  planId?: string;
  stageId?: string;
};

/** 部分成功是一等公民（决策 16）：渐进式推送下"全或无"自相矛盾。 */
export type StepOutcome<T> =
  | { status: "completed"; data: T }
  | { status: "completed_partial"; data: T; missing: { item: string; reason: string }[] }
  | { status: "failed"; error: string };

export type Step<TInput, TOutput> = {
  /** step 标识，写进 WorkflowRun.stepName */
  name: string;
  run: (input: TInput, ctx: StepContext, deps: StepDeps) => Promise<StepOutcome<TOutput>>;
};

/**
 * 单次重试包装（决策 16）。
 *
 * 重试次数刻意固定为 1，与既有 `quality_checking` 的"重试一次然后失败"同口径——
 * 不引入第二套重试策略。更重要的是：图片生成是并发=1 的稀缺全局资源，
 * 无限重试会挤占队列拖垮其他用户。
 */
export async function runWithSingleRetry<TInput, TOutput>(
  step: Step<TInput, TOutput>,
  input: TInput,
  ctx: StepContext,
  deps: StepDeps,
  opts: { onRetry?: (err: string) => void } = {},
): Promise<StepOutcome<TOutput> & { attempts: number }> {
  const attempt = async (): Promise<StepOutcome<TOutput>> => {
    try {
      return await step.run(input, ctx, deps);
    } catch (err) {
      return { status: "failed", error: err instanceof Error ? err.message : String(err) };
    }
  };

  const first = await attempt();
  if (first.status !== "failed") return { ...first, attempts: 1 };

  opts.onRetry?.(first.error);
  const second = await attempt();
  return { ...second, attempts: 2 };
}

/** 记录一次 step 执行到 WorkflowRun，供成本核算与问题追溯 */
export async function recordWorkflowRun(
  prisma: PrismaClient,
  params: {
    jobId: string;
    planId?: string;
    stepName: string;
    finalStatus: string;
    latencyMs?: number;
    retryCount?: number;
    cost?: number;
    provider?: string;
    modelVersion?: string;
    safetyResult?: unknown;
    qualityResult?: unknown;
  },
): Promise<void> {
  await prisma.workflowRun.create({
    data: {
      jobId: params.jobId,
      planId: params.planId,
      stepName: params.stepName,
      finalStatus: params.finalStatus,
      latencyMs: params.latencyMs,
      retryCount: params.retryCount ?? 0,
      cost: params.cost,
      provider: params.provider,
      modelVersion: params.modelVersion,
      safetyResult: (params.safetyResult ?? undefined) as never,
      qualityResult: (params.qualityResult ?? undefined) as never,
    },
  });
}
