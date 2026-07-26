import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { createContainer, type AppContainer } from "../app/container.js";
import { buildApp } from "../app/server.js";
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
    await container.prisma.user.deleteMany({
      where: { deviceSessionId: { in: sessionIds } },
    });
  }
  await app.close();
});

async function createSession() {
  const response = await app.inject({ method: "POST", url: "/auth/device-session" });
  assert.equal(response.statusCode, 201);
  const deviceSessionId = response.json().deviceSessionId as string;
  sessionIds.push(deviceSessionId);
  const user = await container.prisma.user.findUniqueOrThrow({ where: { deviceSessionId } });
  return {
    user,
    cookie: `${SESSION_COOKIE_NAME}=${deviceSessionId}`,
  };
}

async function makeOtherwiseAnalysisReady(
  userId: string,
  age: { confirmed: boolean; birthDate: string },
) {
  await container.prisma.user.update({
    where: { id: userId },
    data: {
      ageConfirmed18Plus: age.confirmed,
      birthDate: new Date(age.birthDate),
    },
  });
  await container.prisma.appearanceProfile.create({
    data: {
      userId,
      track: "short_term",
      domainSelections: ["hair"],
      budgetTier: "low",
    },
  });
  await container.prisma.consentRecord.create({
    data: {
      userId,
      consentType: "face_processing",
      version: "v1",
    },
  });
  await container.prisma.userPhoto.create({
    data: {
      userId,
      photoType: "front",
      storageKey: `raw/${userId}/front.jpg`,
      moderationStatus: "passed",
    },
  });
}

test("basic questionnaire rejects a false 18+ declaration and an underage birth date", async () => {
  const falseDeclaration = await createSession();
  const falseResponse = await app.inject({
    method: "POST",
    url: "/questionnaire/basic",
    headers: { cookie: falseDeclaration.cookie },
    payload: {
      track: "short_term",
      birthDate: "1990-01-01",
      ageConfirmed18Plus: false,
    },
  });
  assert.equal(falseResponse.statusCode, 400);

  const underage = await createSession();
  const underageResponse = await app.inject({
    method: "POST",
    url: "/questionnaire/basic",
    headers: { cookie: underage.cookie },
    payload: {
      track: "short_term",
      birthDate: "2010-01-01",
      ageConfirmed18Plus: true,
    },
  });
  assert.equal(underageResponse.statusCode, 400);
});

test("initial analysis rejects users who have not confirmed 18+ or are underage", async () => {
  const notConfirmed = await createSession();
  await makeOtherwiseAnalysisReady(notConfirmed.user.id, {
    confirmed: false,
    birthDate: "1990-01-01T00:00:00.000Z",
  });
  const notConfirmedResponse = await app.inject({
    method: "POST",
    url: "/analysis-jobs",
    headers: { cookie: notConfirmed.cookie },
  });
  assert.equal(notConfirmedResponse.statusCode, 422);
  assert.ok(
    (notConfirmedResponse.json().issues as { field: string }[]).some(
      (issue) => issue.field === "ageEligibility",
    ),
  );

  const underage = await createSession();
  await makeOtherwiseAnalysisReady(underage.user.id, {
    confirmed: true,
    birthDate: "2010-01-01T00:00:00.000Z",
  });
  const underageResponse = await app.inject({
    method: "POST",
    url: "/analysis-jobs",
    headers: { cookie: underage.cookie },
  });
  assert.equal(underageResponse.statusCode, 422);
  assert.ok(
    (underageResponse.json().issues as { field: string }[]).some(
      (issue) => issue.field === "ageEligibility",
    ),
  );
});

/**
 * `rejected` 在任何环境都不得进入 AI 链路。
 *
 * `pending` 的处置按环境区分（见 `lib/photoModerationGate.ts`）：图片审核 provider
 * 当前搁置，没有任何东西会把 pending 置为 passed；若任何环境都拦，整条链路无法运行。
 * 因此生产 fail closed、本地放行，且放行时 S1 会如实写下 `deferred_no_provider`。
 * 这里断言「rejected 永远被拦」这个不随环境变化的部分。
 */
test("initial analysis does not send a rejected face photo to AI", async () => {
  for (const moderationStatus of ["rejected"] as const) {
    const { user, cookie } = await createSession();
    await makeOtherwiseAnalysisReady(user.id, {
      confirmed: true,
      birthDate: "1990-01-01T00:00:00.000Z",
    });
    await container.prisma.userPhoto.updateMany({
      where: { userId: user.id, photoType: "front" },
      data: { moderationStatus },
    });

    const response = await app.inject({
      method: "POST",
      url: "/analysis-jobs",
      headers: { cookie },
    });
    assert.equal(response.statusCode, 422);
    assert.ok(
      (response.json().issues as { field: string }[]).some(
        (issue) => issue.field === "frontPhoto",
      ),
    );
  }
});

test("initial preview generation shares the same hourly capacity gate", async () => {
  const { user, cookie } = await createSession();
  await makeOtherwiseAnalysisReady(user.id, {
    confirmed: true,
    birthDate: "1990-01-01T00:00:00.000Z",
  });
  const cap = Number(process.env.GENERATION_HOURLY_CAP ?? "3");
  for (let index = 0; index < cap; index++) {
    await container.prisma.analysisJob.create({
      data: {
        userId: user.id,
        jobType: "initial_analysis",
        status: "completed",
        completedAt: new Date(),
      },
    });
  }

  const response = await app.inject({
    method: "POST",
    url: "/analysis-jobs",
    headers: { cookie, "idempotency-key": "privacy-cap-0001" },
  });
  assert.equal(response.statusCode, 429);
  assert.equal(response.json().error, "rate_limited");
});

test("all photo upload paths require active face-processing consent", async () => {
  const { user, cookie } = await createSession();
  await container.prisma.user.update({
    where: { id: user.id },
    data: {
      ageConfirmed18Plus: true,
      birthDate: new Date("1990-01-01T00:00:00.000Z"),
    },
  });

  const uploadUrl = await app.inject({
    method: "POST",
    url: "/photos/upload-url",
    headers: { cookie },
    payload: { photoType: "front", contentType: "image/jpeg" },
  });
  assert.equal(uploadUrl.statusCode, 403);
  assert.equal(uploadUrl.json().error, "face_processing_consent_required");

  const relay = await app.inject({
    method: "POST",
    url: "/photos/upload-relay?photoType=front&contentType=image/jpeg",
    headers: {
      cookie,
      "content-type": "application/octet-stream",
    },
    payload: Buffer.from("not-sent-without-consent"),
  });
  assert.equal(relay.statusCode, 403);
  assert.equal(relay.json().error, "face_processing_consent_required");

  const registration = await app.inject({
    method: "POST",
    url: "/photos",
    headers: { cookie },
    payload: {
      photoType: "front",
      storageKey: `raw/${user.id}/front.jpg`,
    },
  });
  assert.equal(registration.statusCode, 403);
  assert.equal(registration.json().error, "face_processing_consent_required");
});

test("photo registration cannot bind another user's storage key", async () => {
  const { user, cookie } = await createSession();
  await container.prisma.user.update({
    where: { id: user.id },
    data: {
      ageConfirmed18Plus: true,
      birthDate: new Date("1990-01-01T00:00:00.000Z"),
    },
  });
  const consent = await container.prisma.consentRecord.create({
    data: {
      userId: user.id,
      consentType: "face_processing",
      version: "v1",
    },
  });

  const crossTenant = await app.inject({
    method: "POST",
    url: "/photos",
    headers: { cookie },
    payload: {
      photoType: "front",
      storageKey: "raw/another-user/front.jpg",
    },
  });
  assert.equal(crossTenant.statusCode, 403);
  assert.equal(crossTenant.json().error, "storage_key_not_owned");

  const ownKey = `raw/${user.id}/front-${Date.now()}.jpg`;
  const ownRegistration = await app.inject({
    method: "POST",
    url: "/photos",
    headers: { cookie },
    payload: {
      photoType: "front",
      storageKey: ownKey,
    },
  });
  assert.equal(ownRegistration.statusCode, 201);

  await container.prisma.consentRecord.update({
    where: { id: consent.id },
    data: { revokedAt: new Date() },
  });
  const afterRevocation = await app.inject({
    method: "POST",
    url: "/photos",
    headers: { cookie },
    payload: {
      photoType: "front",
      storageKey: `raw/${user.id}/after-revocation.jpg`,
    },
  });
  assert.equal(afterRevocation.statusCode, 403);
  assert.equal(afterRevocation.json().error, "face_processing_consent_required");
});
