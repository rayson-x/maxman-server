import { randomUUID } from "node:crypto";
import { Signer } from "@volcengine/openapi";
import { env, required } from "../../../../config/env.js";
import { getActiveTaskLedger } from "../../../../lib/taskLedger.js";
import { createRateLimiter } from "../../../../lib/rateLimiter.js";
import { withSemaphore } from "../../../../lib/redisSemaphore.js";

/**
 * Thin wrapper around Volcengine's Visual (CV) OpenAPI, which uses the
 * shared Action/Version query-param + AK/SK v4-style signature scheme
 * documented at https://www.volcengine.com/docs/6369/156029.
 *
 * The Visual API's async task pattern (used by 即梦AI image editing, 图片换装,
 * and 文生图) is: CVSync2AsyncSubmitTask -> poll CVSync2AsyncGetResult.
 * req_key values are confirmed empirically per-provider file.
 *
 * Most Volcengine Visual endpoints cap out at 2 QPS and hard-reject anything
 * faster — this applies across submit AND poll calls against this same
 * service, including calls from concurrent/parallel task polls, so every
 * call is funneled through one shared rate limiter here rather than each
 * caller pacing itself independently.
 */

const SERVICE_NAME = "cv";
const MIN_CALL_INTERVAL_MS = Number(process.env.VOLC_MIN_CALL_INTERVAL_MS ?? "600"); // ~1.67 QPS, safety margin under the 2 QPS cap

/**
 * 进程内限流器（tasks 10.5 的取舍）。
 *
 * ⚠ 它**只在单进程内有效**，且只约束单个 HTTP 请求的间隔，不约束在飞的任务数。
 *
 * ⚠ 此处原先写的是「真正保证并发=1 的是 BullMQ 队列的 limiter + concurrency=1」，
 * **这是错的，已被 11.2 实测推翻**：`concurrency` 是每 Worker 实例上限、`limiter`
 * 是启动速率限制，两者都给不了「全局在飞 ≤1」。真正的闸门是
 * `withVolcTaskSlot()`（Redis 信号量，见 lib/redisSemaphore.ts）。
 *
 * 为什么两层都留：
 *   - 信号量负责**任务级并发**（跨进程、权威）——生产路径必须经过它
 *   - 这一层负责**请求级节流**（进程内、兜底）：即使并发=1，submit 与 poll 仍是
 *     两类请求，poll 每 2s 一次，多个调用点叠加照样能撞上 2 QPS。它也保护那些
 *     不经队列的路径（测试脚本、一次性运维脚本）。
 *
 * 若设 `VOLC_SKIP_INPROCESS_RATE_LIMIT=1`，则完全交给信号量层——仅用于需要
 * 刻意制造并发以验证信号量本身的测试，生产不要设。
 */
const SKIP_INPROCESS_LIMIT = process.env.VOLC_SKIP_INPROCESS_RATE_LIMIT === "1";
const inProcessLimiter = createRateLimiter(MIN_CALL_INTERVAL_MS);
const rateLimit = <T>(fn: () => Promise<T>): Promise<T> => (SKIP_INPROCESS_LIMIT ? fn() : inProcessLimiter(fn));

export interface VolcVisualRequestParams {
  Action: string;
  Version: string;
}

export async function callVolcVisualAPI<T = unknown>(
  params: VolcVisualRequestParams,
  body: Record<string, unknown>,
): Promise<T> {
  const accessKeyId = required("VOLC_ACCESS_KEY_ID");
  const secretKey = required("VOLC_SECRET_ACCESS_KEY");

  const bodyStr = JSON.stringify(body);
  const query = new URLSearchParams({
    Action: params.Action,
    Version: params.Version,
  }).toString();

  const requestData = {
    region: env.volc.region,
    method: "POST",
    params: { Action: params.Action, Version: params.Version },
    headers: {
      Host: env.volc.visualHost,
      "Content-Type": "application/json",
    },
    body: bodyStr,
  };

  const signer = new Signer(requestData, SERVICE_NAME);
  signer.addAuthorization({ accessKeyId, secretKey });

  const url = `https://${env.volc.visualHost}/?${query}`;
  return rateLimit(async () => {
    const res = await fetch(url, {
      method: "POST",
      headers: requestData.headers as Record<string, string>,
      body: bodyStr,
    });

    const json = await res.json();
    if (!res.ok) {
      throw new Error(`Volcengine Visual API error (${res.status}): ${JSON.stringify(json)}`);
    }
    return json as T;
  });
}

/**
 * Submits a task and durably records it under its returned task_id (=callId)
 * before returning, so the call is traceable/billable even if the caller
 * never manages to poll it to completion (crash, disconnect, etc.) — see
 * resumeVolcVisualTask.
 */
export async function submitVolcVisualTask(
  reqKey: string,
  body: Record<string, unknown>,
  opts: { purpose?: string } = {},
) {
  // 提交**之前**落 prepared。此后若在拿到 task_id 前崩溃，恢复流程能看到
  // 「我们打算调用过」，而不是完全无记录——那时无从判断是否已计费。
  // 火山不接受客户端幂等键也无法按客户端键查询，所以这条记录的作用是
  // 让过期后能转 unknown 进对账，而不是用来自动重提。
  const providerRequestKey = `volc-${reqKey}-${randomUUID()}`;
  await getActiveTaskLedger().recordPrepared({
    providerRequestKey,
    provider: "volcengine",
    reqKey,
    purpose: opts.purpose,
    requestBody: body,
  });

  const result = await callVolcVisualAPI<{ code: number; data?: { task_id: string }; message?: string }>(
    { Action: "CVSync2AsyncSubmitTask", Version: "2022-08-31" },
    { req_key: reqKey, ...body },
  );
  if (result.data?.task_id) {
    await getActiveTaskLedger().recordSubmitted({
      providerRequestKey,
      callId: result.data.task_id,
      provider: "volcengine",
      reqKey,
      purpose: opts.purpose,
      requestBody: body,
    });
  }
  return result;
}

export async function getVolcVisualResult(reqKey: string, taskId: string) {
  const result = await callVolcVisualAPI<{ code: number; data?: { status: string; image_urls?: string[] }; message?: string }>(
    { Action: "CVSync2AsyncGetResult", Version: "2022-08-31" },
    // req_json.return_url must be set on the GET call too, not just at submit
    // time, or the response omits image_urls (confirmed empirically).
    { req_key: reqKey, task_id: taskId, req_json: JSON.stringify({ return_url: true }) },
  );
  const status = result.data?.status;
  if (status === "done" || status === "success") {
    await getActiveTaskLedger().recordResult(taskId, { status: "done", resultUrls: result.data?.image_urls });
  } else if (status === "failed" || status === "error" || status === "not_found" || status === "expired") {
    await getActiveTaskLedger().recordResult(taskId, { status: "failed", error: status });
  } else if (status) {
    await getActiveTaskLedger().recordProgress(taskId, "polling");
  }
  return result;
}

/** Poll until the task reaches a terminal state, or timeout. */
export async function pollVolcVisualResult(
  reqKey: string,
  taskId: string,
  opts: { intervalMs?: number; timeoutMs?: number } = {},
) {
  const intervalMs = opts.intervalMs ?? 2000;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await getVolcVisualResult(reqKey, taskId);
    const status = result.data?.status;
    if (status === "done" || status === "success") return result;
    if (status === "failed" || status === "error") {
      throw new Error(`Volcengine task ${taskId} failed: ${JSON.stringify(result)}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Volcengine task ${taskId} timed out after ${timeoutMs}ms`);
}

/**
 * 在**跨进程并发保护**下执行一次完整的 submit→poll。
 *
 * 这是修一个实测出来的 bug（tasks 11.2）：BullMQ 的 `concurrency` 是每个 Worker
 * 实例的上限、`limiter` 是启动速率限制，**两者都给不了「全局同时在飞不超过 N 个」**。
 * 实测 2 个 Worker + 真实调用时，limiter 在 1.2s 后放行第二个任务，而第一个还要跑
 * 19 秒——重叠后供应商返回 code 50430，6 个任务 4 个被拒。
 *
 * 必须锁住**整个生命周期**而不只是 submit：供应商的并发计数看的是「服务端有几个
 * 任务在跑」，不是「有几个 HTTP 请求在途」。
 *
 * 槽位按 **req_key 分组**——12.4 实测确认不同 req_key 使用独立并发池，
 * 所以文生图和图生图各占一个槽，可以并行。
 */
export async function withVolcTaskSlot<T>(reqKey: string, fn: () => Promise<T>): Promise<T> {
  return withSemaphore(
    `volc:${reqKey}`,
    {
      // 实测各 req_key 池上限为 1；可通过 env 覆盖（若付费扩容）
      slots: Number(process.env.VOLC_TASK_SLOTS ?? "1"),
      // TTL 必须大于最长单次调用耗时。实测提交+轮询最长约 25s，取 120s 留足余量——
      // 太短会让持有者还在跑就被抢占，又回到并发冲突
      ttlMs: Number(process.env.VOLC_TASK_SLOT_TTL_MS ?? "120000"),
    },
    fn,
  );
}

/**
 * Resume polling a previously-submitted task using only its callId — reads
 * the reqKey back out of the ledger, so a caller that crashed/disconnected
 * after submit can pick up the same task instead of resubmitting (and
 * getting billed twice).
 */
export async function resumeVolcVisualTask(callId: string, opts: { intervalMs?: number; timeoutMs?: number } = {}) {
  const entry = await getActiveTaskLedger().getEntry(callId);
  if (!entry) throw new Error(`No task-ledger entry found for callId ${callId}`);
  return pollVolcVisualResult(entry.reqKey, callId, opts);
}
