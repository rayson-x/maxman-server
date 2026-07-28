import assert from "node:assert/strict";
import test from "node:test";
import { reviewerPrompt } from "./reviewer.js";

test("reviewer prompt contains only structured diff/channel evidence, never photo URLs or raw prompts", () => {
  const prompt = reviewerPrompt({
    domain: "hairstyle",
    diffResult: { diffScore: 0.8, invalidBIds: ["unknown"] },
    channels: [{
      channel: "A",
      structuredResult: {
        candidates: [{ nameZh: "短碎发" }],
        photoUrl: "https://short-lived.example/original-front",
        rawPrompt: "SECRET-RAW-PROMPT",
      },
    }],
  });
  assert.match(prompt, /hairstyle/);
  assert.match(prompt, /短碎发/);
  assert.doesNotMatch(prompt, /https?:\/\//);
  assert.doesNotMatch(prompt, /SECRET-RAW-PROMPT/);
});
