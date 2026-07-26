import "dotenv/config";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createVolcengineImageEditProvider } from "../features/appearance-agent/providers/imageEdit/volcengineImageEdit.js";

/**
 * Fact-finding: can plain img2img (¥0.2) produce usable full-body OUTFIT
 * previews from a categorical text instruction, or do we need swap-outfit
 * (¥1, requires a concrete garment image)?
 *
 * Prior evidence is inconclusive: "换成深蓝色衬衫" worked on a headshot, but a
 * headshot only shows the collar — that says nothing about swapping a whole
 * outfit on a full-body shot.
 */
const SOURCE_IMAGE = "test-fixtures/clothing-swap/model.jpg"; // full-body, white tee + black trousers
const OUT_DIR = "test-fixtures/outfit-img2img";

const CASES = [
  {
    id: "smart-casual",
    instruction: "把身上的衣服换成深蓝色修身衬衫配米色直筒休闲裤，保持人物姿势和身材不变",
  },
  {
    id: "knit-layered",
    instruction: "把身上的衣服换成灰色针织衫内搭白色衬衫，下身深色直筒裤，保持人物姿势和身材不变",
  },
  {
    id: "jacket",
    instruction: "把身上的衣服换成深色休闲西装外套配白色T恤，下身深灰色长裤，保持人物姿势和身材不变",
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
