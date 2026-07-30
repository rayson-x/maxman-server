import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../app/server.js";
import { createContainer, type AppContainer } from "../app/container.js";
import { SESSION_COOKIE_NAME } from "../services/sessionService.js";

/*
 * 出图付费，而假发是一条用户可能根本不选的路径。所以假发款的预览图必须能被单独请求 ——
 * 只在用户点开入口后才发生 —— 而不带范围时行为必须与从前逐位一致。
 */

let container: AppContainer;
let app: FastifyInstance;
const sessionIds: string[] = [];

before(async () => {
  container = createContainer({ withQueues: false, withProviders: false });
  app = await buildApp({ container, logger: false });
});

after(async () => {
  if (sessionIds.length > 0) {
    await container.prisma.user.deleteMany({ where: { deviceSessionId: { in: sessionIds } } });
  }
  await app.close();
});

async function planWithSelectedStyle(seed: number) {
  const session = await app.inject({ method: "POST", url: "/auth/device-session" });
  const deviceSessionId = session.json().deviceSessionId as string;
  sessionIds.push(deviceSessionId);
  const user = await container.prisma.user.findUniqueOrThrow({ where: { deviceSessionId } });
  const plan = await container.prisma.appearancePlan.create({
    data: {
      userId: user.id,
      track: "short_term",
      generationSeed: seed,
      selectedStyle: { id: "clean-fit", nameZh: "干净简约" },
    },
  });
  return {
    user,
    plan,
    headers: { cookie: `${SESSION_COOKIE_NAME}=${deviceSessionId}` },
  };
}

async function readySet(planId: string, kind: "hairstyle" | "hairstyle_wig", fingerprint: string) {
  return container.prisma.recommendationSet.create({
    data: {
      planId,
      kind,
      status: "ready",
      computationKey: `${kind}:${fingerprint}`,
      inputFingerprint: fingerprint,
      source: "catalog_matching",
      capabilityStatus: {},
    },
  });
}

test("a wig-scoped preview request is rejected until a wig set exists", async () => {
  const { plan, headers } = await planWithSelectedStyle(910);
  await readySet(plan.id, "hairstyle", "default-only");

  const response = await app.inject({
    method: "POST",
    url: `/plans/${plan.id}/hairstyle-previews`,
    headers: { ...headers, "idempotency-key": "wig-scope-missing-0001" },
    payload: { scope: "wig" },
  });

  // 默认集合已 ready 也不算数：请求的是假发那批，没有就不能出图。
  assert.equal(response.statusCode, 422);
  assert.equal(response.json().error, "hairstyle_recommendation_not_ready");
});

test("omitting the scope keeps today's behaviour and needs only the default set", async () => {
  const { plan, headers } = await planWithSelectedStyle(911);
  await readySet(plan.id, "hairstyle", "default-behaviour");

  const response = await app.inject({
    method: "POST",
    url: `/plans/${plan.id}/hairstyle-previews`,
    headers: { ...headers, "idempotency-key": "wig-scope-default-0001" },
  });

  // 这套测试容器不带队列，入队必然失败，所以断言的是**门禁已放行**而不是最终 202。
  assert.notEqual(response.statusCode, 422);
  assert.notEqual(response.json().error, "hairstyle_recommendation_not_ready");
});

test("a wig-scoped request is accepted once the wig set is ready", async () => {
  const { plan, headers } = await planWithSelectedStyle(912);
  await readySet(plan.id, "hairstyle", "both-default");
  await readySet(plan.id, "hairstyle_wig", "both-wig");

  const response = await app.inject({
    method: "POST",
    url: `/plans/${plan.id}/hairstyle-previews`,
    headers: { ...headers, "idempotency-key": "wig-scope-ready-0001" },
    payload: { scope: "wig" },
  });

  // 同上：只断言门禁放行了假发那批。
  assert.notEqual(response.statusCode, 422);
  assert.notEqual(response.json().error, "hairstyle_recommendation_not_ready");
});

test("a default-scoped request is rejected when only the wig set exists", async () => {
  // 反向也要成立，否则「范围」只是装饰：假发集合不能替默认集合放行出图。
  const { plan, headers } = await planWithSelectedStyle(913);
  await readySet(plan.id, "hairstyle_wig", "wig-only");

  const response = await app.inject({
    method: "POST",
    url: `/plans/${plan.id}/hairstyle-previews`,
    headers: { ...headers, "idempotency-key": "wig-scope-inverse-0001" },
  });

  assert.equal(response.statusCode, 422);
  assert.equal(response.json().error, "hairstyle_recommendation_not_ready");
});

test("an unknown scope is rejected rather than silently treated as default", async () => {
  const { plan, headers } = await planWithSelectedStyle(914);
  await readySet(plan.id, "hairstyle", "bad-scope");

  const response = await app.inject({
    method: "POST",
    url: `/plans/${plan.id}/hairstyle-previews`,
    headers: { ...headers, "idempotency-key": "wig-scope-bad-0001" },
    payload: { scope: "everything" },
  });

  assert.equal(response.statusCode, 400);
});
