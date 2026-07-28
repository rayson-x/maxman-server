import "dotenv/config";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createArkSeedreamImageEditProvider } from "../features/appearance-agent/providers/imageEdit/arkSeedreamImageEdit.js";
import { OBJECTIVE_HAIRSTYLE_ATTRIBUTES } from "../features/appearance-agent/data/objectiveHairstyleAttributes.js";
import { NEGATIVE_PROMPT, identityConstraint } from "../services/targetImageService.js";

/**
 * Seedream 4.5 发型指令 A/B 质量台。
 *
 * 这个台子不修改线上目录，也不把「看起来好看」误当成通过：每一格都必须人工按
 * 发型命中 / 正脸姿态 / 身份与肤质 / 非头发区域四项打分。任意姿态或身份项为 0，
 * 该模板即不可上线。先跑四个已知风险款；B 不显著改善就停止扩展到八款。
 *
 * 用法：
 *   npm run build && node dist/scripts/bench-seedream-hairstyle-quality.js --photo ./real-face.tmp.jpg
 *   ... --styles 三七侧分,侧分短发 --out bench-out/seedream-quality-manual
 */

const DEFAULT_MODEL = "doubao-seedream-4-5-251128";
const DEFAULT_STYLES = ["三七侧分", "侧分短发", "中分短发", "短寸"];

type Template = {
  id: "A" | "B";
  label: string;
  instruction: (description: string) => string;
  negativePrompt?: string;
};

const TEMPLATES: Template[] = [
  {
    id: "A",
    label: "A · 当前生产模板（含方舟追加的避免项）",
    instruction: (description) => `把这个人的发型改成：${description} ${identityConstraint("头发")}`,
    negativePrompt: NEGATIVE_PROMPT,
  },
  {
    id: "B",
    label: "B · Seedream 专用短模板（不传伪 negative prompt）",
    instruction: (description) =>
      `仅编辑头发区域。保持原图正面拍摄角度、头部朝向、脸型、五官、表情、肤色、皮肤纹理、耳朵、手、衣服和背景完全不变；不得转头、侧脸、改变相机角度或构图。目标头发：${description}。发丝自然真实。`,
  },
];

const EXPECTED_ANCHORS: Record<string, string> = {
  "三七侧分": "3:7 分线；较长一侧只轻扫额角；不遮眼；鬓角自然薄而非推光",
  "侧分短发": "自然侧分；斜刘海只盖额角；保持正脸、不遮眼",
  "中分短发": "正中分线；两束刘海分别垂落；耳朵半露；不是侧分",
  "短寸": "全头约 1cm 均匀短发；无刘海；额头完全露出",
};

function valueAfter(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const photoPath = valueAfter("--photo");
if (!photoPath || !existsSync(photoPath)) {
  console.error("需要一个存在的 --photo <本地正脸照片路径>");
  process.exit(1);
}

const wantedNames = (valueAfter("--styles") ?? DEFAULT_STYLES.join(","))
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);
const styles = OBJECTIVE_HAIRSTYLE_ATTRIBUTES.filter((style) => wantedNames.includes(style.canonicalName));
if (styles.length !== wantedNames.length) {
  const found = new Set(styles.map((style) => style.canonicalName));
  console.error(`未找到发型：${wantedNames.filter((name) => !found.has(name)).join("、")}`);
  process.exit(1);
}

const runId = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = valueAfter("--out") ?? join("bench-out", `seedream-quality-${runId}`);
mkdirSync(outDir, { recursive: true });

const sourceBytes = readFileSync(photoPath);
const sourceBase64 = sourceBytes.toString("base64");
const sourceFile = "source.jpg";
writeFileSync(join(outDir, sourceFile), sourceBytes);
const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
const provider = createArkSeedreamImageEditProvider(DEFAULT_MODEL);

type Cell = {
  style: string;
  description: string;
  expectedAnchors: string;
  templateId: Template["id"];
  templateLabel: string;
  instruction: string;
  /** 方舟的真实发送值；其 API 没有 negative_prompt。 */
  effectivePrompt: string;
  negativePrompt?: string;
  file: string | null;
  latencyMs: number | null;
  error?: string;
  scores: {
    hairstyleAccuracy: null;
    frontalPose: null;
    identityAndSkin: null;
    nonHairRegions: null;
  };
};

const cells: Cell[] = [];
for (const style of styles) {
  for (const template of TEMPLATES) {
    const instruction = template.instruction(style.renderDescription);
    const effectivePrompt = template.negativePrompt
      ? `${instruction} 避免出现：${template.negativePrompt}`
      : instruction;
    const file = `${style.canonicalName}-${template.id}.jpg`;
    const cell: Cell = {
      style: style.canonicalName,
      description: style.renderDescription,
      expectedAnchors: EXPECTED_ANCHORS[style.canonicalName] ?? "请在报告中补齐该款的结构锚点",
      templateId: template.id,
      templateLabel: template.label,
      instruction,
      effectivePrompt,
      negativePrompt: template.negativePrompt,
      file,
      latencyMs: null,
      scores: { hairstyleAccuracy: null, frontalPose: null, identityAndSkin: null, nonHairRegions: null },
    };
    const number = cells.length + 1;
    process.stdout.write(`[${number}/${styles.length * TEMPLATES.length}] ${style.canonicalName} / ${template.id} … `);
    try {
      const result = await provider.edit({
        imageBase64: sourceBase64,
        instruction,
        negativePrompt: template.negativePrompt,
        seed: 42,
      });
      const bytes = result.imageBase64
        ? Buffer.from(result.imageBase64, "base64")
        : result.imageUrl
          ? Buffer.from(await (await fetch(result.imageUrl)).arrayBuffer())
          : null;
      if (!bytes) throw new Error("provider 未返回 imageUrl 或 imageBase64");
      writeFileSync(join(outDir, file), bytes);
      cell.latencyMs = result.latencyMs;
      console.log(`ok ${result.latencyMs}ms`);
    } catch (error) {
      cell.file = null;
      cell.error = error instanceof Error ? error.message : String(error);
      console.log(`失败：${cell.error.slice(0, 160)}`);
    }
    cells.push(cell);
  }
}

const manifest = {
  benchmark: "seedream-hairstyle-quality-ab-v1",
  createdAt: new Date().toISOString(),
  provider: provider.name,
  model: DEFAULT_MODEL,
  size: process.env.ARK_IMAGE_EDIT_SIZE ?? "2K",
  seed: 42,
  source: { file: sourceFile, originalPath: basename(photoPath), sha256: sourceSha256 },
  scoringGuide: {
    hairstyleAccuracy: "0=错误类别，1=部分命中，2=所有关键锚点命中",
    frontalPose: "0=转头/重构，1=轻微漂移，2=正脸不变",
    identityAndSkin: "0=换脸或明显磨皮，1=轻微重绘，2=五官与皮肤纹理保持",
    nonHairRegions: "0=背景/身体明显重绘，1=轻微漂移，2=保持",
    gate: "frontalPose 或 identityAndSkin 为 0 即 FAIL；其余三项均至少 1 且 hairstyleAccuracy=2 才可扩展测试。",
  },
  cells,
};
writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

const esc = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const cellHtml = (cell: Cell) => `
  <article class="card">
    ${cell.file ? `<img src="${esc(cell.file)}" alt="${esc(`${cell.style} ${cell.templateId}`)}">` : `<div class="missing">生成失败</div>`}
    <div class="body">
      <h3>${esc(cell.templateLabel)}</h3>
      <p><b>结构锚点：</b>${esc(cell.expectedAnchors)}</p>
      <details><summary>实际 instruction</summary><code>${esc(cell.instruction)}</code></details>
      <details><summary>方舟实际 effective prompt</summary><code>${esc(cell.effectivePrompt)}</code></details>
      <p class="note">${cell.error ? esc(cell.error) : `${cell.latencyMs ?? "?"}ms · seed 42 · 2K`}</p>
      <div class="score">人工评分待填：发型命中 ☐0 ☐1 ☐2　正脸姿态 ☐0 ☐1 ☐2<br>身份/肤质 ☐0 ☐1 ☐2　非头发区域 ☐0 ☐1 ☐2</div>
    </div>
  </article>`;
const groups = styles.map((style) => {
  const entries = cells.filter((cell) => cell.style === style.canonicalName);
  return `<section><h2>${esc(style.canonicalName)}</h2><p class="desc">${esc(style.renderDescription)}</p><div class="grid">${entries.map(cellHtml).join("\n")}</div></section>`;
}).join("\n");

const html = `<!doctype html><meta charset="utf-8"><title>Seedream 4.5 发型质量 A/B</title>
<style>
  body{font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;margin:24px;background:#f7f5f0;color:#141210}
  h1{margin:0 0 4px}.meta,.note{color:#756f68;font-size:12px}.source{display:flex;gap:16px;align-items:flex-start;background:#fff;border:3px solid #141210;padding:12px;margin:20px 0 32px}.source img{width:240px}.source p{max-width:720px}.grid{display:grid;grid-template-columns:repeat(2,minmax(300px,1fr));gap:20px}.card{background:#fff;border:3px solid #141210;box-shadow:5px 5px 0 #141210}.card img,.missing{width:100%;display:block}.missing{aspect-ratio:4/3;display:grid;place-items:center;background:#ede7dd}.body{padding:12px}.body h3{margin:0 0 6px;font-size:15px}.body p{margin:8px 0}.desc{margin-top:-8px;color:#4e4943}code{display:block;white-space:pre-wrap;word-break:break-word;background:#f2efe9;padding:8px;margin-top:6px;font:11px/1.55 ui-monospace,monospace}.score{margin-top:12px;padding:8px;background:#fff8cf;font-size:12px}@media(max-width:760px){.grid{grid-template-columns:1fr}.source{display:block}.source img{width:100%}}
</style>
<h1>Seedream 4.5 · 发型质量 A/B</h1><div class="meta">模型 ${esc(DEFAULT_MODEL)} · 2K · 固定 seed 42 · ${cells.filter((cell) => cell.file).length}/${cells.length} 成功</div>
<div class="source"><img src="source.jpg" alt="源图"><p><b>使用方法：</b>不要只选“更好看”的图。对每张按四项填 0–2：发型命中、正脸姿态、身份/肤质、非头发区域。正脸姿态或身份/肤质为 0 即 FAIL；只有发型命中为 2 且其余三项至少为 1，才允许将该模板扩到第二批 4 款。完整机器可读记录见 <code>manifest.json</code>。</p></div>
${groups}`;
writeFileSync(join(outDir, "index.html"), html);

console.log(`\n完成 ${cells.filter((cell) => cell.file).length}/${cells.length}`);
console.log(`报告：${join(outDir, "index.html")}`);
