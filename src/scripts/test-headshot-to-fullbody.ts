import "dotenv/config";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createVolcengineImageEditProvider } from "../features/appearance-agent/providers/imageEdit/volcengineImageEdit.js";

/**
 * Fact-finding for the "no full-body photo" branch: can SeedEdit turn a
 * headshot into an identity-preserving FULL-BODY shot with a given outfit?
 *
 * Prior knowledge says this is doubtful — SeedEdit's output aspect ratio
 * follows the input, and it is an *edit* model, not an outpainting/expansion
 * model. Testing rather than assuming.
 */
const SOURCE_IMAGE = "test-fixtures/faces/01-round.jpg"; // 1024x1024 headshot
const OUT_DIR = "test-fixtures/headshot-to-fullbody";

const CASES = [
  {
    id: "direct-fullbody",
    instruction: "把镜头拉远，改成这个人的全身站姿照片，穿深蓝色衬衫和米色长裤，纯灰色背景",
  },
  {
    id: "with-body-params",
    instruction: "生成这个人的全身照，身高175cm偏瘦体型，站姿，穿深蓝色衬衫配米色长裤，摄影棚灰色背景",
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
