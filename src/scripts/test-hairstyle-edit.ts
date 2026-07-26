import "dotenv/config";
import { readFile, writeFile } from "node:fs/promises";
import { createVolcengineImageEditProvider } from "../features/appearance-agent/providers/imageEdit/volcengineImageEdit.js";

const SOURCE_IMAGE = "test-fixtures/faces/01-round.jpg";
const OUT_DIR = "test-fixtures/hairstyle-edit";

const INSTRUCTIONS = [
  { id: "perm", instruction: "把头发改成蓬松的烫卷发型，保持发色不变" },
  { id: "longer", instruction: "把头发改长，改成中长发，自然垂顺" },
  { id: "buzzcut", instruction: "把头发剪成寸头板寸发型" },
];

async function main() {
  await import("node:fs/promises").then((fs) => fs.mkdir(OUT_DIR, { recursive: true }));

  const buf = await readFile(SOURCE_IMAGE);
  const base64 = buf.toString("base64");
  const provider = createVolcengineImageEditProvider();

  for (const { id, instruction } of INSTRUCTIONS) {
    console.log(`\n[${id}] instruction: ${instruction}`);
    const result = await provider.edit({ imageBase64: base64, instruction });
    console.log(`[${id}] callId=${result.callId} latency=${result.latencyMs}ms`);
    if (!result.imageUrl) {
      console.log(`[${id}] FAILED — no imageUrl in result:`, JSON.stringify(result.raw));
      continue;
    }
    const res = await fetch(result.imageUrl);
    const outBuf = Buffer.from(await res.arrayBuffer());
    const outFile = `${OUT_DIR}/${id}.png`;
    await writeFile(outFile, outBuf);
    console.log(`[${id}] saved -> ${outFile}`);
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
