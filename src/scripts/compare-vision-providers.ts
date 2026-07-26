import "dotenv/config";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { createZhipuVisionProvider } from "../features/appearance-agent/providers/vision/zhipuVision.js";
import { createQwenVisionProvider } from "../features/appearance-agent/providers/vision/qwenVision.js";
import { createHunyuanVisionProvider } from "../features/appearance-agent/providers/vision/hunyuanVision.js";
import type { VisionAnalysisProvider } from "../features/appearance-agent/providers/vision/types.js";

const FIXTURES_DIR = "test-fixtures/faces";
const OUT_FILE = "test-fixtures/faces/vision-comparison.md";

const PROMPT =
  "请分析这张照片中人物的脸型、发型、发际线状态、是否有胡须、是否戴眼镜。只输出结构化JSON，" +
  "字段包括 face_shape, hairstyle, hairline, facial_hair, glasses, estimated_age_range。" +
  "不要做医学诊断，不要评判性描述。";

async function toDataUrl(file: string): Promise<string> {
  const buf = await readFile(file);
  return `data:image/jpeg;base64,${buf.toString("base64")}`;
}

async function tryAnalyze(provider: VisionAnalysisProvider, imageUrl: string) {
  try {
    const result = await provider.analyze({ imageUrl, prompt: PROMPT });
    return { ok: true as const, ...result };
  } catch (err) {
    return { ok: false as const, provider: provider.name, error: err instanceof Error ? err.message : String(err) };
  }
}

async function main() {
  const providers = [createZhipuVisionProvider(), createQwenVisionProvider(), createHunyuanVisionProvider()];

  const files = (await readdir(FIXTURES_DIR))
    .filter((f) => f.endsWith(".jpg"))
    .sort();

  const sections: string[] = [`# Vision Provider Comparison\n`, `Prompt used for all providers:\n\n\`\`\`\n${PROMPT}\n\`\`\`\n`];

  for (const file of files) {
    const id = file.replace(/\.jpg$/, "");
    console.log(`\n=== ${id} ===`);
    const imageUrl = await toDataUrl(`${FIXTURES_DIR}/${file}`);

    const results = await Promise.all(providers.map((p) => tryAnalyze(p, imageUrl)));

    sections.push(`## ${id}\n`);
    sections.push(`![${id}](./${file})\n`);
    for (const r of results) {
      if (r.ok) {
        console.log(`[${r.provider}] OK (${r.latencyMs}ms)`);
        sections.push(`### ${r.provider} (${r.model}, ${r.latencyMs}ms)\n\n\`\`\`\n${r.rawText}\n\`\`\`\n`);
      } else {
        console.log(`[${r.provider}] FAILED: ${r.error}`);
        sections.push(`### ${r.provider} — FAILED\n\n\`\`\`\n${r.error}\n\`\`\`\n`);
      }
    }
  }

  await writeFile(OUT_FILE, sections.join("\n"));
  console.log(`\nWritten to ${OUT_FILE}`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
