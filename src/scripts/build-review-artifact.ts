import "dotenv/config";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { createZhipuVisionProvider } from "../features/appearance-agent/providers/vision/zhipuVision.js";
import { createQwenVisionProvider } from "../features/appearance-agent/providers/vision/qwenVision.js";

const FACES_DIR = "test-fixtures/faces";
const SWAP_DIR = "test-fixtures/clothing-swap";
const HAIR_DIR = "test-fixtures/hairstyle-edit";
const HAIR_SOURCE = `${FACES_DIR}/01-round.jpg`;
const HAIR_VARIANTS = [
  { id: "perm", label: "烫卷发", caption: "蓬松烫卷发型，保持发色不变" },
  { id: "longer", label: "中长发", caption: "改长，自然垂顺中分" },
  { id: "buzzcut", label: "寸头", caption: "剪成板寸发型" },
];
const OUT_FILE = "/private/tmp/claude-501/-Users-Ruihan-go-src-BetterMeet/2bd99e02-51bc-4fa3-a374-7f3081496f91/scratchpad/provider-review.html";

const PROMPT =
  "请分析这张照片中人物的脸型、发型、发际线状态、是否有胡须、是否戴眼镜。只输出结构化JSON，" +
  "字段包括 face_shape, hairstyle, hairline, facial_hair, glasses, estimated_age_range。" +
  "不要做医学诊断，不要评判性描述。";

const LABELS: Record<string, string> = {
  "01-round": "圆脸",
  "02-square": "方脸",
  "03-long": "长脸",
  "04-oval": "瓜子脸 / 鹅蛋脸",
  "05-guozi": "国字脸",
  "06-youzi": "由字脸",
  "07-jiazi": "甲字脸",
  "08-glasses": "圆脸 + 眼镜",
  "09-beard": "方脸 + 胡须",
  "10-receding": "长脸 + 发际线后移",
};

function toDataUrl(buf: Buffer, mime: string): string {
  return `data:${mime};base64,${buf.toString("base64")}`;
}

function parseJsonField(rawText: string): Record<string, string> | null {
  const match = rawText.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fieldRowsHtml(parsed: Record<string, string> | null, raw: string): string {
  if (!parsed) {
    return `<pre class="raw">${escapeHtml(raw)}</pre>`;
  }
  const labels: Record<string, string> = {
    face_shape: "脸型",
    hairstyle: "发型",
    hairline: "发际线",
    facial_hair: "胡须",
    glasses: "眼镜",
    estimated_age_range: "年龄区间",
  };
  return Object.entries(parsed)
    .map(([k, v]) => {
      const label = labels[k] ?? k;
      const value = typeof v === "object" ? JSON.stringify(v) : String(v);
      return `<div class="field"><span class="field-key">${escapeHtml(label)}</span><span class="field-value">${escapeHtml(value)}</span></div>`;
    })
    .join("\n");
}

async function main() {
  const zhipu = createZhipuVisionProvider();
  const qwen = createQwenVisionProvider();

  const files = (await readdir(FACES_DIR)).filter((f) => f.endsWith(".jpg")).sort();

  const faceCards: string[] = [];
  for (const file of files) {
    const id = file.replace(/\.jpg$/, "");
    console.log(`Analyzing ${id}...`);
    const buf = await readFile(`${FACES_DIR}/${file}`);
    const imageUrl = toDataUrl(buf, "image/jpeg");

    const [zhipuResult, qwenResult] = await Promise.all([
      zhipu.analyze({ imageUrl, prompt: PROMPT }),
      qwen.analyze({ imageUrl, prompt: PROMPT }),
    ]);

    const zhipuParsed = parseJsonField(zhipuResult.rawText);
    const qwenParsed = parseJsonField(qwenResult.rawText);

    faceCards.push(`
      <article class="face-card">
        <div class="face-media">
          <img src="${imageUrl}" alt="${escapeHtml(LABELS[id] ?? id)}" loading="lazy" />
          <span class="face-tag">${escapeHtml(LABELS[id] ?? id)}</span>
        </div>
        <div class="provider-panel provider-zhipu">
          <div class="provider-head"><span class="provider-dot"></span>Zhipu GLM-4V<span class="latency">${zhipuResult.latencyMs}ms</span></div>
          ${fieldRowsHtml(zhipuParsed, zhipuResult.rawText)}
        </div>
        <div class="provider-panel provider-qwen">
          <div class="provider-head"><span class="provider-dot"></span>Qwen-VL-Plus<span class="latency">${qwenResult.latencyMs}ms</span></div>
          ${fieldRowsHtml(qwenParsed, qwenResult.rawText)}
        </div>
      </article>`);
  }

  console.log("Reading clothing-swap fixtures...");
  const modelBuf = await readFile(`${SWAP_DIR}/model.jpg`);
  const garmentBuf = await readFile(`${SWAP_DIR}/garment.jpg`);
  const resultBuf = await readFile(`${SWAP_DIR}/result.png`);
  const modelUrl = toDataUrl(modelBuf, "image/jpeg");
  const garmentUrl = toDataUrl(garmentBuf, "image/jpeg");
  const resultUrl = toDataUrl(resultBuf, "image/png");

  console.log("Reading hairstyle-edit fixtures...");
  const hairSourceUrl = toDataUrl(await readFile(HAIR_SOURCE), "image/jpeg");
  const hairVariantCards = await Promise.all(
    HAIR_VARIANTS.map(async (v) => {
      const url = toDataUrl(await readFile(`${HAIR_DIR}/${v.id}.png`), "image/png");
      return `
      <div class="hair-item">
        <span class="hair-badge">${escapeHtml(v.label)}</span>
        <img src="${url}" alt="${escapeHtml(v.label)}" />
        <div class="swap-caption">${escapeHtml(v.caption)}</div>
      </div>`;
    }),
  );

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>Provider 对比 — BetterMeet</title>
<style>
  :root {
    --bg: #f5f6f8;
    --surface: #ffffff;
    --border: #e1e4ea;
    --text: #1a1e24;
    --muted: #667085;
    --mono: ui-monospace, "SFMono-Regular", "Menlo", "Consolas", monospace;
    --sans: ui-sans-serif, "Segoe UI", -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
    --zhipu: #0e7c86;
    --zhipu-bg: #e7f4f4;
    --qwen: #6d5bd0;
    --qwen-bg: #efecfb;
    --swap: #b45309;
    --swap-bg: #fbf0e0;
    --hair: #2563eb;
    --hair-bg: #e8effe;
    --radius: 10px;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14171c;
      --surface: #1b1f26;
      --border: #2a2f38;
      --text: #e7e9ec;
      --muted: #8b93a1;
      --zhipu: #35b8c2;
      --zhipu-bg: #12292b;
      --qwen: #9a8bf0;
      --qwen-bg: #22203a;
      --swap: #e0a458;
      --swap-bg: #2b2114;
      --hair: #5b8def;
      --hair-bg: #16233a;
    }
  }
  :root[data-theme="dark"] {
    --bg: #14171c; --surface: #1b1f26; --border: #2a2f38; --text: #e7e9ec; --muted: #8b93a1;
    --zhipu: #35b8c2; --zhipu-bg: #12292b; --qwen: #9a8bf0; --qwen-bg: #22203a; --swap: #e0a458; --swap-bg: #2b2114;
    --hair: #5b8def; --hair-bg: #16233a;
  }
  :root[data-theme="light"] {
    --bg: #f5f6f8; --surface: #ffffff; --border: #e1e4ea; --text: #1a1e24; --muted: #667085;
    --zhipu: #0e7c86; --zhipu-bg: #e7f4f4; --qwen: #6d5bd0; --qwen-bg: #efecfb; --swap: #b45309; --swap-bg: #fbf0e0;
    --hair: #2563eb; --hair-bg: #e8effe;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: var(--sans);
    line-height: 1.5;
  }
  .wrap { max-width: 1180px; margin: 0 auto; padding: 48px 24px 96px; }
  header { margin-bottom: 40px; }
  .eyebrow {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
    font-weight: 600;
    margin-bottom: 8px;
  }
  h1 { font-size: 28px; font-weight: 700; margin: 0 0 8px; text-wrap: balance; }
  .subtitle { color: var(--muted); font-size: 15px; max-width: 640px; }
  .legend { display: flex; gap: 20px; margin-top: 20px; flex-wrap: wrap; }
  .legend-item { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--muted); }
  .legend-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }

  section.block { margin-top: 56px; }
  .block-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 20px; gap: 12px; flex-wrap: wrap; }
  h2 { font-size: 18px; font-weight: 700; margin: 0; }
  .block-note { color: var(--muted); font-size: 13px; }

  .face-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 20px;
  }
  .face-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
  }
  .face-media { position: relative; aspect-ratio: 2 / 3; overflow: hidden; background: var(--bg); }
  .face-media img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .face-tag {
    position: absolute; left: 10px; bottom: 10px;
    background: rgba(20, 22, 26, 0.72);
    color: #fff;
    font-size: 12px;
    padding: 4px 9px;
    border-radius: 999px;
    backdrop-filter: blur(4px);
  }
  .provider-panel { padding: 12px 14px; border-top: 1px solid var(--border); }
  .provider-zhipu { background: var(--zhipu-bg); }
  .provider-qwen { background: var(--qwen-bg); }
  .provider-head {
    display: flex; align-items: center; gap: 7px;
    font-size: 12px; font-weight: 700; letter-spacing: 0.02em;
    margin-bottom: 8px;
  }
  .provider-zhipu .provider-head { color: var(--zhipu); }
  .provider-qwen .provider-head { color: var(--qwen); }
  .provider-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; flex-shrink: 0; }
  .latency { margin-left: auto; font-family: var(--mono); font-weight: 500; color: var(--muted); font-variant-numeric: tabular-nums; }
  .field { display: flex; justify-content: space-between; gap: 10px; font-size: 12.5px; padding: 3px 0; border-bottom: 1px dashed var(--border); }
  .field:last-child { border-bottom: none; }
  .field-key { color: var(--muted); flex-shrink: 0; }
  .field-value { font-family: var(--mono); text-align: right; }
  pre.raw { font-family: var(--mono); font-size: 11px; white-space: pre-wrap; margin: 0; color: var(--muted); }

  .swap-row {
    display: grid;
    grid-template-columns: 1fr auto 1fr auto 1fr;
    align-items: center;
    gap: 18px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 20px;
  }
  .swap-item { text-align: center; }
  .swap-item img { width: 100%; max-width: 260px; border-radius: 8px; display: block; margin: 0 auto 10px; }
  .swap-caption { font-size: 12.5px; color: var(--muted); }
  .swap-arrow { color: var(--swap); font-size: 22px; font-weight: 700; }
  .swap-badge {
    display: inline-block; font-size: 11px; font-weight: 700; letter-spacing: 0.04em;
    color: var(--swap); background: var(--swap-bg); padding: 3px 9px; border-radius: 999px; margin-bottom: 8px;
  }

  .hair-block {
    display: grid;
    grid-template-columns: minmax(200px, 260px) 1fr;
    gap: 20px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 20px;
    align-items: stretch;
  }
  .hair-source { text-align: center; }
  .hair-source img { width: 100%; max-width: 240px; border-radius: 8px; display: block; margin: 0 auto 10px; }
  .hair-variants { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
  .hair-item { text-align: center; }
  .hair-item img { width: 100%; border-radius: 8px; display: block; margin: 0 auto 10px; border: 2px solid var(--hair-bg); }
  .hair-badge {
    display: inline-block; font-size: 11px; font-weight: 700; letter-spacing: 0.04em;
    color: var(--hair); background: var(--hair-bg); padding: 3px 9px; border-radius: 999px; margin-bottom: 8px;
  }

  @media (max-width: 720px) {
    .swap-row { grid-template-columns: 1fr; }
    .swap-arrow { transform: rotate(90deg); }
    .hair-block { grid-template-columns: 1fr; }
    .hair-variants { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="eyebrow">BetterMeet · Server</div>
    <h1>Provider 对比测试结果</h1>
    <p class="subtitle">10 张合成中国男性测试脸型 × 2 个vision provider 的识别结果对比，外加换装(clothing-swap)链路的端到端验证。</p>
    <div class="legend">
      <div class="legend-item"><span class="legend-dot" style="background:var(--zhipu)"></span>Zhipu GLM-4V</div>
      <div class="legend-item"><span class="legend-dot" style="background:var(--qwen)"></span>Qwen-VL-Plus</div>
      <div class="legend-item"><span class="legend-dot" style="background:var(--swap)"></span>Volcengine 换装 (dressing_diffusion)</div>
      <div class="legend-item"><span class="legend-dot" style="background:var(--hair)"></span>Volcengine 发型改造 (SeedEdit 3.0)</div>
    </div>
  </header>

  <section class="block">
    <div class="block-head">
      <h2>人脸识别 — 10 组测试图</h2>
      <span class="block-note">Hunyuan-vision 因API key失效未纳入本次对比</span>
    </div>
    <div class="face-grid">
      ${faceCards.join("\n")}
    </div>
  </section>

  <section class="block">
    <div class="block-head">
      <h2>换装 — 端到端验证</h2>
      <span class="block-note">req_key: dressing_diffusion (V1)</span>
    </div>
    <div class="swap-row">
      <div class="swap-item">
        <span class="swap-badge">模特图</span>
        <img src="${modelUrl}" alt="模特图" />
        <div class="swap-caption">白T恤 + 黑裤，合成生成</div>
      </div>
      <div class="swap-arrow">→</div>
      <div class="swap-item">
        <span class="swap-badge">服装图</span>
        <img src="${garmentUrl}" alt="服装图" />
        <div class="swap-caption">红格纹长袖衬衫，产品图</div>
      </div>
      <div class="swap-arrow">→</div>
      <div class="swap-item">
        <span class="swap-badge">换装结果</span>
        <img src="${resultUrl}" alt="换装结果" />
        <div class="swap-caption">姿势/脸部保留，服装成功替换</div>
      </div>
    </div>
  </section>

  <section class="block">
    <div class="block-head">
      <h2>发型改造 — 同一张脸的三种发型</h2>
      <span class="block-note">req_key: seededit_v3.0，同一张原图，三条独立指令</span>
    </div>
    <div class="hair-block">
      <div class="hair-source">
        <span class="hair-badge">原图</span>
        <img src="${hairSourceUrl}" alt="原图" />
        <div class="swap-caption">01-round 测试脸</div>
      </div>
      <div class="hair-variants">
        ${hairVariantCards.join("\n")}
      </div>
    </div>
  </section>
</div>
</body>
</html>`;

  await writeFile(OUT_FILE, html);
  console.log(`\nWritten to ${OUT_FILE}`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
