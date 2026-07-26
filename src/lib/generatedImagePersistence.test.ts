import assert from "node:assert/strict";
import test from "node:test";

import { persistGeneratedImage } from "./generatedImagePersistence.js";

function fakePng(size = 128): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(size),
  ]);
}

function fakeJpeg(size = 128): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.alloc(size),
    Buffer.from([0xff, 0xd9]),
  ]);
}

test("base64 PNG is bounded, labeled, and persisted once", async () => {
  const writes: Buffer[] = [];
  const result = await persistGeneratedImage(
    {
      result: {
        provider: "stepfun",
        imageBase64: fakePng().toString("base64"),
        latencyMs: 1,
      },
      userId: "user",
      filenameBase: "preview",
      planId: "plan",
      minBytes: 1,
    },
    {
      putObject: async (_key, bytes) => {
        writes.push(bytes);
      },
    },
  );

  assert.equal(result.format, "png");
  assert.equal(writes.length, 1);
  assert.ok(writes[0].includes(Buffer.from("AI-Generated\u0000true")));
});

test("HTTPS provider URL is checked and JPEG receives an implicit AI marker", async () => {
  const writes: Buffer[] = [];
  const result = await persistGeneratedImage(
    {
      result: {
        provider: "volcengine",
        imageUrl: "https://images.example.com/result.jpg",
        latencyMs: 1,
      },
      userId: "user",
      filenameBase: "target",
      minBytes: 1,
    },
    {
      fetchImpl: async () =>
        new Response(fakeJpeg(), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        }),
      resolveHostname: async () => ["203.0.113.10"],
      putObject: async (_key, bytes) => {
        writes.push(bytes);
      },
    },
  );

  assert.equal(result.format, "jpeg");
  assert.match(result.storageKey, /\.jpg$/);
  assert.ok(writes[0].includes(Buffer.from("AI-Generated=true")));
});

test("unsafe URLs, HTTP failures, and oversized bodies are never persisted", async () => {
  const base = {
    result: {
      provider: "provider",
      imageUrl: "http://127.0.0.1/private",
      latencyMs: 1,
    },
    userId: "user",
    filenameBase: "bad",
    minBytes: 1,
  };
  await assert.rejects(() => persistGeneratedImage(base), /HTTPS|安全/);

  await assert.rejects(
    () =>
      persistGeneratedImage(
        {
          ...base,
          result: { ...base.result, imageUrl: "https://images.example.com/fail" },
        },
        {
          fetchImpl: async () => new Response("upstream error", { status: 502 }),
          resolveHostname: async () => ["203.0.113.10"],
          putObject: async () => {
            throw new Error("must not write");
          },
        },
      ),
    /502/,
  );

  await assert.rejects(
    () =>
      persistGeneratedImage(
        {
          ...base,
          result: { ...base.result, imageUrl: "https://images.example.com/huge" },
          maxBytes: 16,
        },
        {
          fetchImpl: async () =>
            new Response(fakePng(32), {
              status: 200,
              headers: { "content-length": "40" },
            }),
          resolveHostname: async () => ["203.0.113.10"],
        },
      ),
    /过大/,
  );

  await assert.rejects(
    () =>
      persistGeneratedImage(
        {
          ...base,
          result: { ...base.result, imageUrl: "https://images.example.com/rebind" },
        },
        {
          resolveHostname: async () => ["127.0.0.1"],
          fetchImpl: async () => {
            throw new Error("must not fetch a private DNS result");
          },
        },
      ),
    /DNS.*安全/,
  );
});
