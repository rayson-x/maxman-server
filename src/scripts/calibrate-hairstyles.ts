import "dotenv/config";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { getImageEditProvider } from "../features/appearance-agent/composition.js";
import { OBJECTIVE_HAIRSTYLE_ATTRIBUTES } from "../features/appearance-agent/data/objectiveHairstyleAttributes.js";
import { identityConstraint, NEGATIVE_PROMPT } from "../services/targetImageService.js";

/**
 * 发型渲染描述的校准台。
 *
 * 为什么需要它：`renderDescription` 是**逐款措辞校准**出来的，不是推导出来的。
 * 实测已经踩到三类坑，且都只在真人照上才暴露（合成证件照原本就是短发贴头，
 * 改动量小，错的也看不出来）：
 *   1. 指令里带发型名 → 模型按错误先验出图，且名称的先验压倒描述
 *   2. 分缝/背头不写顶部长度 → 被读成"剪到很短"，退化成寸头
 *   3. 施工感动词（"压出发缝"/"剪短贴头"）→ 被读成剃出来的硬分缝、铲青
 *
 * 一次跑完 15 款并生成并排对照页，改完描述就能重跑，比一款一款看快得多。
 *
 * 用法：
 *   npm run calibrate -- --photo ./my.jpg                 # 全部 15 款
 *   npm run calibrate -- --photo ./my.jpg --only 微碎盖,三七侧分
 *   npm run calibrate -- --photo ./my.jpg --force          # 重生成已存在的
 *
 * ⚠ 每款一次真实出图（约 ¥0.2）。默认**跳过已生成**的，避免重跑时白烧钱；
 * 改了某款描述后用 `--only` 单独重跑它。
 */

const OUT_DIR = "calibration-out";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

const photoPath = arg("photo");
if (!photoPath) {
  console.error("需要 --photo <本地图片路径>");
  console.error("例：npm run calibrate -- --photo ./test-fixtures/faces/03-long.jpg");
  process.exit(1);
}
if (!existsSync(photoPath)) {
  console.error(`找不到照片：${photoPath}`);
  process.exit(1);
}

const only = arg("only")?.split(",").map((s) => s.trim()).filter(Boolean);
const force = hasFlag("force");

const targets = OBJECTIVE_HAIRSTYLE_ATTRIBUTES.filter(
  (a) => !only || only.includes(a.canonicalName),
);
if (targets.length === 0) {
  console.error(`--only 没匹配到任何发型。可选：${OBJECTIVE_HAIRSTYLE_ATTRIBUTES.map((a) => a.canonicalName).join("、")}`);
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
const photoBuf = readFileSync(photoPath);
// 直接用 base64 喂 provider，不必先上传 OSS——校准是本地行为，不该产生云端副作用
const photoBase64 = photoBuf.toString("base64");
writeFileSync(join(OUT_DIR, "source.jpg"), photoBuf);

const provider = getImageEditProvider();
type Row = { name: string; description: string; prompt: string; file: string | null; note: string };
const rows: Row[] = [];

console.log(`源图：${photoPath}`);
console.log(`待渲染：${targets.length} 款${only ? `（--only）` : ""}${force ? "，强制重生成" : "，跳过已存在"}\n`);

for (const [i, attrs] of targets.entries()) {
  const file = `${attrs.canonicalName}.jpg`;
  const outPath = join(OUT_DIR, file);
  // 与线上完全一致的拼装：不带发型名，只给动作描述
  const prompt = `把这个人的发型改成：${attrs.renderDescription} ${identityConstraint("头发")}`;
  const base = { name: attrs.canonicalName, description: attrs.renderDescription, prompt };

  if (!force && existsSync(outPath)) {
    console.log(`[${i + 1}/${targets.length}] ${attrs.canonicalName} —— 已存在，跳过`);
    rows.push({ ...base, file, note: "已存在（未重新生成）" });
    continue;
  }

  process.stdout.write(`[${i + 1}/${targets.length}] ${attrs.canonicalName} … `);
  try {
    // provider 并发上限为 1，withVolcTaskSlot 在内部串行，这里顺序 await 即可
    const result = await provider.edit({
      imageBase64: photoBase64,
      instruction: prompt,
      negativePrompt: NEGATIVE_PROMPT,
      seed: 42, // 固定 seed，改描述前后可直接对比
    });
    if (!result.imageUrl) {
      console.log("无返回图");
      rows.push({ ...base, file: null, note: "provider 未返回图片" });
      continue;
    }
    const img = Buffer.from(await (await fetch(result.imageUrl)).arrayBuffer());
    writeFileSync(outPath, img);
    console.log(`ok ${result.latencyMs}ms`);
    rows.push({ ...base, file, note: `${result.latencyMs}ms` });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.log(`失败：${msg.slice(0, 100)}`);
    rows.push({ ...base, file: null, note: `失败：${msg.slice(0, 120)}` });
  }
}

// 并排对照页。每款都把**实际发出的 prompt** 一起显示——校准时要看的是
// "这段话产出了这张图"，只看图判断不了该改哪个词。
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const html = `<!doctype html>
<meta charset="utf-8">
<title>发型渲染校准 · ${esc(basename(photoPath))}</title>
<style>
  body { font: 14px/1.6 -apple-system, "PingFang SC", sans-serif; margin: 24px; background: #f7f5f0; color: #141210; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .meta { color: #8a857d; font-size: 12px; margin-bottom: 24px; }
  .src { display: flex; gap: 16px; align-items: flex-start; margin-bottom: 28px;
         border: 3px solid #141210; background: #fff; padding: 12px; }
  .src img { width: 240px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 20px; }
  .card { border: 3px solid #141210; background: #fff; box-shadow: 5px 5px 0 #141210; }
  .card img { width: 100%; display: block; }
  .card .body { padding: 12px; }
  .card h2 { font-size: 16px; margin: 0 0 8px; }
  .desc { font-size: 13px; }
  .prompt { font: 11px/1.6 ui-monospace, monospace; color: #55504a; background: #f2efe9;
            padding: 8px; margin-top: 8px; word-break: break-all; }
  .note { font: 11px ui-monospace, monospace; color: #8a857d; margin-top: 6px; }
  .fail { color: #d4391c; }
  .missing { aspect-ratio: 1; display: flex; align-items: center; justify-content: center;
             background: #efe9df; color: #8a857d; font-size: 12px; }
</style>
<h1>发型渲染校准</h1>
<div class="meta">源图 ${esc(basename(photoPath))} · seed 42 · scale 0.5 · ${rows.length} 款 · 生成时间见文件时间戳</div>
<div class="src">
  <img src="source.jpg" alt="源图">
  <div>
    <strong>反向 prompt</strong>
    <div class="prompt">${esc(NEGATIVE_PROMPT)}</div>
    <div class="note">校准要点：① 指令里不写发型名（名称先验会压倒描述）② 分缝/背头要写顶部长度
    ③ 避开施工感动词（"压出发缝"→剃出硬分缝，"剪短贴头"→铲青）</div>
  </div>
</div>
<div class="grid">
${rows
  .map(
    (r) => `  <div class="card">
    ${r.file ? `<img src="${esc(r.file)}" alt="${esc(r.name)}">` : `<div class="missing">未生成</div>`}
    <div class="body">
      <h2>${esc(r.name)}</h2>
      <div class="desc">${esc(r.description)}</div>
      <div class="prompt">${esc(r.prompt)}</div>
      <div class="note${r.file ? "" : " fail"}">${esc(r.note)}</div>
    </div>
  </div>`,
  )
  .join("\n")}
</div>
`;
writeFileSync(join(OUT_DIR, "index.html"), html);

const ok = rows.filter((r) => r.file).length;
console.log(`\n完成 ${ok}/${rows.length}`);
console.log(`对照页：${join(OUT_DIR, "index.html")}`);
console.log(`改完某款描述后单独重跑：npm run calibrate -- --photo ${photoPath} --only <发型名> --force`);
process.exit(0);
