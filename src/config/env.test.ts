import assert from "node:assert/strict";
import test from "node:test";
import { resolveServerHost } from "./env.js";

test("API binds to loopback unless HOST is explicitly configured", () => {
  assert.equal(resolveServerHost(undefined), "127.0.0.1");
  assert.equal(resolveServerHost("0.0.0.0"), "0.0.0.0");
});
