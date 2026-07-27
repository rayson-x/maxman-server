import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../app/server.js";
import { createContainer, type AppContainer } from "../app/container.js";
import { SESSION_COOKIE_NAME } from "../services/sessionService.js";

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

test("style direction must be selected before outfit generation and must come from the first round", async () => {
  const session = await app.inject({ method: "POST", url: "/auth/device-session" });
  assert.equal(session.statusCode, 201);
  const deviceSessionId = session.json().deviceSessionId as string;
  sessionIds.push(deviceSessionId);
  const user = await container.prisma.user.findUniqueOrThrow({ where: { deviceSessionId } });
  const plan = await container.prisma.appearancePlan.create({
    data: { userId: user.id, track: "short_term", generationSeed: 42 },
  });
  await container.prisma.analysisJob.create({
    data: {
      userId: user.id,
      planId: plan.id,
      jobType: "initial_analysis",
      status: "completed",
      completedAt: new Date(),
      partialResult: {
        styleRecommendations: [
          { id: "clean-fit", nameZh: "干净简约", description: "基础利落", rationale: "适合日常" },
        ],
      },
    },
  });
  const headers = { cookie: `${SESSION_COOKIE_NAME}=${deviceSessionId}`, "idempotency-key": "style-direction-e2e-0001" };

  const blocked = await app.inject({ method: "POST", url: `/plans/${plan.id}/outfit-previews`, headers });
  assert.equal(blocked.statusCode, 422);
  assert.equal(blocked.json().error, "style_not_selected");

  const invented = await app.inject({
    method: "POST",
    url: `/plans/${plan.id}/select-style-direction`,
    headers,
    payload: { styleId: "invented-style" },
  });
  assert.equal(invented.statusCode, 422);

  const selected = await app.inject({
    method: "POST",
    url: `/plans/${plan.id}/select-style-direction`,
    headers,
    payload: { styleId: "clean-fit" },
  });
  assert.equal(selected.statusCode, 200);
  assert.equal(selected.json().style.id, "clean-fit");

  const nextGate = await app.inject({ method: "POST", url: `/plans/${plan.id}/outfit-previews`, headers });
  assert.equal(nextGate.statusCode, 422);
  assert.equal(nextGate.json().error, "hairstyle_not_selected");
});
