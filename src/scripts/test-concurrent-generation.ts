import "dotenv/config";
import { readFile } from "node:fs/promises";
import { createVolcengineImageEditProvider } from "../features/appearance-agent/providers/imageEdit/volcengineImageEdit.js";

/**
 * Fact-finding: does Volcengine SeedEdit allow multiple CONCURRENT tasks?
 *
 * This decides whether the onboarding preview set completes in ~20s (parallel)
 * or ~84s (effectively serial). The 图片换装 doc states 并发限额 1; the 图生图
 * doc gives no number. Measuring rather than guessing.
 *
 * Also validates the "一个任务合集，谁先完成返回谁" semantics: we log the actual
 * completion ORDER, which is what the progressive-push design would surface.
 */
const SOURCE_IMAGE = "test-fixtures/faces/01-round.jpg";

const INSTRUCTIONS = [
  { id: "hair-1", instruction: "把头发改成蓬松的纹理烫短发" },
  { id: "hair-2", instruction: "把头发改成清爽的寸头板寸" },
  { id: "hair-3", instruction: "把头发改成偏分的微碎盖发型" },
  { id: "hair-4", instruction: "把头发改成利落的背头造型" },
  { id: "hair-5", instruction: "把头发改成中长的自然垂顺发型" },
  { id: "hair-6", instruction: "把头发改成飞机头造型" },
];

async function main() {
  const buf = await readFile(SOURCE_IMAGE);
  const base64 = buf.toString("base64");
  const provider = createVolcengineImageEditProvider();

  const t0 = Date.now();
  const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
  let completionIndex = 0;

  console.log(`Firing ${INSTRUCTIONS.length} edits concurrently at t=0...\n`);

  const results = await Promise.allSettled(
    INSTRUCTIONS.map(({ id, instruction }) =>
      provider
        .edit({ imageBase64: base64, instruction })
        .then((r) => {
          completionIndex += 1;
          console.log(
            `  #${completionIndex} DONE  [${id}]  wall=${elapsed()}  providerLatency=${r.latencyMs}ms  callId=${r.callId}  hasImage=${Boolean(r.imageUrl)}`,
          );
          return { id, ok: true as const };
        })
        .catch((err) => {
          completionIndex += 1;
          console.log(`  #${completionIndex} FAIL  [${id}]  wall=${elapsed()}  ${err instanceof Error ? err.message : err}`);
          throw err;
        }),
    ),
  );

  const ok = results.filter((r) => r.status === "fulfilled").length;
  console.log(`\nTotal wall clock: ${elapsed()}   succeeded: ${ok}/${INSTRUCTIONS.length}`);
  console.log(
    ok === INSTRUCTIONS.length
      ? "→ Concurrency ALLOWED. Compare total wall clock against ~14s (fully parallel) vs ~84s (fully serial)."
      : "→ Some tasks failed; check whether the errors indicate a concurrency limit.",
  );
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
