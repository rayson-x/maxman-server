import "dotenv/config";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createVolcengineImageEditProvider } from "../features/appearance-agent/providers/imageEdit/volcengineImageEdit.js";

/**
 * Fact-finding: does SeedEdit apply MULTIPLE accumulated changes in one call?
 * The "target image = baseline + cumulative ChangeManifestEntry list" design
 * depends on this; only single-instruction edits have been validated so far.
 */
const SOURCE_IMAGE = "test-fixtures/faces/09-beard.jpg"; // has beard, so "shave" is observable
const OUT_DIR = "test-fixtures/multi-change-edit";

const CASES = [
  {
    id: "two-changes",
    instruction: "把头发改成蓬松的烫卷发型，并且把胡须剃干净",
  },
  {
    id: "three-changes",
    instruction: "把头发改成蓬松的烫卷发型，把胡须剃干净，再戴上一副黑框眼镜",
  },
  {
    id: "four-changes-listy",
    instruction: "同时完成以下改变：1.头发改成蓬松烫卷 2.剃干净胡须 3.戴黑框眼镜 4.换成深蓝色衬衫",
  },
];

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const buf = await readFile(SOURCE_IMAGE);
  const base64 = buf.toString("base64");
  const provider = createVolcengineImageEditProvider();

  for (const { id, instruction } of CASES) {
    console.log(`\n[${id}] (${instruction.length} chars) ${instruction}`);
    try {
      const result = await provider.edit({ imageBase64: base64, instruction });
      if (!result.imageUrl) {
        console.log(`[${id}] NO IMAGE:`, JSON.stringify(result.raw));
        continue;
      }
      const res = await fetch(result.imageUrl);
      const outBuf = Buffer.from(await res.arrayBuffer());
      await writeFile(`${OUT_DIR}/${id}.png`, outBuf);
      console.log(`[${id}] saved (callId=${result.callId}, ${result.latencyMs}ms)`);
    } catch (err) {
      console.log(`[${id}] FAILED:`, err instanceof Error ? err.message : err);
    }
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
