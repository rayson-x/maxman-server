import "dotenv/config";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { createVolcengineImageEditProvider } from "../features/appearance-agent/providers/imageEdit/volcengineImageEdit.js";
import { createQwenImageEditProvider } from "../features/appearance-agent/providers/imageEdit/qwenImageEdit.js";
import { createArkSeedreamImageEditProvider } from "../features/appearance-agent/providers/imageEdit/arkSeedreamImageEdit.js";
import type { ImageEditProvider } from "../features/appearance-agent/providers/imageEdit/types.js";
import { OBJECTIVE_HAIRSTYLE_ATTRIBUTES } from "../features/appearance-agent/data/objectiveHairstyleAttributes.js";
import { identityConstraint, NEGATIVE_PROMPT } from "../services/targetImageService.js";

/**
 * 出图**质感**对照台（跟 calibrate-hairstyles.ts 分工不同）。
 *
 * calibrate 回答的是「这段描述出的是不是这个发型」——横轴是 15 款发型，纵轴固定。
 * 这里回答的是「同一款发型，换模型/换措辞/换分辨率，哪个更像真头发」——
 * 横轴是配置，纵轴才是发型。
 *
 * 立这个台子的直接原因：真人照 1:1 裁切下发现 SeedEdit 3.0 把**整幅画面**重画了
 * （原图额头痘印和毛孔消失、脸被削窄、输出还从 1280×960 降到 1152×864），
 * 而我们的 prompt 里没有一句要求修皮肤瘦脸。所以「一眼假」的主因不在措辞，
 * 单靠改发型描述测不出来，必须换轴对比。
 *
 * 用法：
 *   npm run bench:image -- --photo ./real-face.tmp.jpg
 *   npm run bench:image -- --photo ./real-face.tmp.jpg --styles 微碎盖,三七侧分
 *   npm run bench:image -- --photo ./real-face.tmp.jpg --variants A,D
 *
 * ⚠ 每格一次真实出图。默认**跳过已生成**的，`--force` 才重跑。
 * 默认 2 款 × 全部可用配置。配了 ARK_API_KEY 就是 7 档，没配是 A–D 四档。
 */

const OUT_DIR = "bench-out";
const DEFAULT_STYLES = ["微碎盖", "三七侧分"];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);
const list = (name: string) =>
  arg(name)?.split(",").map((s) => s.trim()).filter(Boolean);

type Variant = {
  id: string;
  label: string;
  why: string;
  provider: () => ImageEditProvider;
  /** 附加在正向 prompt 末尾的质感措辞 */
  positiveSuffix?: string;
  negativePrompt: string;
  /** 是否先把源图放大到短边 1536 再喂进去 */
  hires?: boolean;
};

const VARIANTS: Variant[] = [
  {
    id: "A",
    label: "A · SeedEdit 3.0（现状）",
    why: "线上当前配置，作为基准",
    provider: createVolcengineImageEditProvider,
    negativePrompt: NEGATIVE_PROMPT,
  },
  {
    id: "B",
    label: "B · SeedEdit + 质感措辞",
    why: "正向加发丝质感，反向加假发/塑料——验证措辞还有没有余量",
    provider: createVolcengineImageEditProvider,
    positiveSuffix: "发丝根根分明，有自然光泽",
    negativePrompt: `${NEGATIVE_PROMPT}，假发，发套，头发像塑料，发缘生硬`,
  },
  {
    id: "C",
    label: "C · SeedEdit + 高分输入",
    why: "源图先放大到短边 1536——验证发丝细节是不是被降采样吃掉的",
    provider: createVolcengineImageEditProvider,
    negativePrompt: NEGATIVE_PROMPT,
    hires: true,
  },
  {
    id: "D",
    label: "D · Qwen-Image-Edit-Plus",
    why: "换模型。它对未编辑区域的像素保持通常好于 SeedEdit",
    provider: createQwenImageEditProvider,
    negativePrompt: NEGATIVE_PROMPT,
  },
  // E/F/G 需要 ARK_API_KEY（方舟凭证 ≠ 视觉智能 AK/SK）。
  // 没配 key 时默认集合会自动剔掉它们，见下面 defaultVariantIds()；
  // 显式 `--variants E` 仍然会跑，好让你看到确切的报错。
  {
    id: "E",
    label: "E · Seedream 4.0（2K）",
    why: "方舟上唯一 size 可控的一家，验证分辨率天花板能不能突破",
    provider: () => arkWith("doubao-seedream-4-0-250828"),
    negativePrompt: NEGATIVE_PROMPT,
  },
  {
    id: "F",
    label: "F · Seedream 4.5（2K）",
    why: "同族更新一档",
    provider: () => arkWith("doubao-seedream-4-5-251128"),
    negativePrompt: NEGATIVE_PROMPT,
  },
  {
    id: "G",
    label: "G · Seedream 5.0 lite（2K）",
    why: "同族最新，写实度预期最高",
    provider: () => arkWith("doubao-seedream-5-0-260128"),
    negativePrompt: NEGATIVE_PROMPT,
  },
];

const arkWith = (model: string): ImageEditProvider => createArkSeedreamImageEditProvider(model);

const ARK_VARIANT_IDS = ["E", "F", "G"];
/** 缺方舟 key 时别白跑 6 格必失败的格子 */
function defaultVariantIds(): string[] {
  const all = VARIANTS.map((v) => v.id);
  if (process.env.ARK_API_KEY) return all;
  console.log("未配 ARK_API_KEY，默认集合跳过 Seedream（E/F/G）。配好后重跑即可补上这几格。\n");
  return all.filter((id) => !ARK_VARIANT_IDS.includes(id));
}

const photoPath = arg("photo");
if (!photoPath) {
  console.error("需要 --photo <本地图片路径>");
  process.exit(1);
}
if (!existsSync(photoPath)) {
  console.error(`找不到照片：${photoPath}`);
  process.exit(1);
}

// 提出成独立 const：闭包里 TS 不保留 process.exit 之后的收窄
const sourcePath: string = photoPath;
const force = hasFlag("force");
const wantStyles = list("styles") ?? DEFAULT_STYLES;
const wantVariants = list("variants");

const styles = OBJECTIVE_HAIRSTYLE_ATTRIBUTES.filter((a) => wantStyles.includes(a.canonicalName));
if (styles.length !== wantStyles.length) {
  const missing = wantStyles.filter((n) => !styles.some((s) => s.canonicalName === n));
  console.error(`--styles 里这些没匹配到：${missing.join("、")}`);
  console.error(`可选：${OBJECTIVE_HAIRSTYLE_ATTRIBUTES.map((a) => a.canonicalName).join("、")}`);
  process.exit(1);
}
const activeIds = wantVariants ?? defaultVariantIds();
const variants = VARIANTS.filter((v) => activeIds.includes(v.id));

mkdirSync(OUT_DIR, { recursive: true });
const photoBuf = readFileSync(photoPath);
writeFileSync(join(OUT_DIR, "source.jpg"), photoBuf);

/** 短边放大到 1536，用系统 ImageMagick（校准台是本地脚本，依赖 magick 可接受） */
function hiresBase64(): string {
  const out = join(OUT_DIR, "source-hires.jpg");
  if (!existsSync(out)) {
    execFileSync("magick", [sourcePath, "-resize", "1536x1536^", "-quality", "95", out]);
  }
  return readFileSync(out).toString("base64");
}

const baseBase64 = photoBuf.toString("base64");
let hires: string | undefined;

// provider 实例按需创建：只跑 --variants A 时不该因为缺 DashScope key 而崩
const providerCache = new Map<string, ImageEditProvider>();
function providerFor(v: Variant): ImageEditProvider {
  const cached = providerCache.get(v.id);
  if (cached) return cached;
  const p = v.provider();
  providerCache.set(v.id, p);
  return p;
}

type Cell = { file: string | null; note: string; prompt: string; negative: string };
const cells = new Map<string, Cell>();
const key = (style: string, variantId: string) => `${style}|${variantId}`;

console.log(`源图：${photoPath}`);
console.log(`${styles.length} 款 × ${variants.length} 配置 = ${styles.length * variants.length} 格${force ? "（强制重生成）" : "（跳过已存在）"}\n`);

let n = 0;
const total = styles.length * variants.length;
for (const style of styles) {
  for (const v of variants) {
    n += 1;
    const name = style.canonicalName;
    const file = `${name}-${v.id}.jpg`;
    const outPath = join(OUT_DIR, file);
    const desc = v.positiveSuffix ? `${style.renderDescription}，${v.positiveSuffix}` : style.renderDescription;
    const prompt = `把这个人的发型改成：${desc} ${identityConstraint("头发")}`;
    const cell: Cell = { file, note: "", prompt, negative: v.negativePrompt };

    if (!force && existsSync(outPath)) {
      console.log(`[${n}/${total}] ${name} / ${v.id} —— 已存在，跳过`);
      cells.set(key(name, v.id), { ...cell, note: "已存在（未重新生成）" });
      continue;
    }

    process.stdout.write(`[${n}/${total}] ${name} / ${v.id} … `);
    try {
      if (v.hires && !hires) hires = hiresBase64();
      const result = await providerFor(v).edit({
        imageBase64: v.hires ? hires : baseBase64,
        instruction: prompt,
        negativePrompt: v.negativePrompt,
        seed: 42,
      });
      if (!result.imageUrl) {
        console.log("无返回图");
        cells.set(key(name, v.id), { ...cell, file: null, note: "provider 未返回图片" });
        continue;
      }
      const img = Buffer.from(await (await fetch(result.imageUrl)).arrayBuffer());
      writeFileSync(outPath, img);
      let dim = "";
      try {
        dim = execFileSync("magick", ["identify", "-format", "%wx%h", outPath]).toString();
      } catch {
        /* identify 失败不影响主流程 */
      }
      console.log(`ok ${result.latencyMs}ms ${dim}`);
      cells.set(key(name, v.id), { ...cell, note: `${result.latencyMs}ms · ${dim}` });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.log(`失败：${msg.slice(0, 140)}`);
      cells.set(key(name, v.id), { ...cell, file: null, note: `失败：${msg.slice(0, 200)}` });
    }
  }
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
let srcDim = "";
try {
  srcDim = execFileSync("magick", ["identify", "-format", "%wx%h", join(OUT_DIR, "source.jpg")]).toString();
} catch {
  /* 可选信息 */
}

const html = `<!doctype html>
<meta charset="utf-8">
<title>出图质感对照 · ${esc(basename(photoPath))}</title>
<style>
  body { font: 14px/1.6 -apple-system, "PingFang SC", sans-serif; margin: 24px; background: #f7f5f0; color: #141210; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .meta { color: #8a857d; font-size: 12px; margin-bottom: 20px; }
  .hint { border: 3px solid #141210; background: #fff; padding: 12px; margin-bottom: 24px; font-size: 13px; }
  .hint b { display: block; margin-bottom: 4px; }
  table { border-collapse: separate; border-spacing: 14px; }
  th { font-size: 13px; text-align: left; vertical-align: bottom; width: 320px; }
  th .why { display: block; color: #8a857d; font-size: 11px; font-weight: 400; margin-top: 2px; }
  td { vertical-align: top; }
  .rowhead { width: 120px; font-size: 15px; font-weight: 700; }
  .cell { border: 3px solid #141210; background: #fff; box-shadow: 5px 5px 0 #141210; width: 320px; }
  .cell img { width: 100%; display: block; }
  .cell .foot { padding: 8px 10px; font: 11px ui-monospace, monospace; color: #55504a; }
  .prompt { font: 10px/1.5 ui-monospace, monospace; color: #6b6660; background: #f2efe9; padding: 6px 8px; word-break: break-all; }
  .fail { color: #d4391c; }
  .missing { aspect-ratio: 4/3; display: flex; align-items: center; justify-content: center; background: #efe9df; color: #8a857d; font-size: 12px; }
  .src img { width: 320px; border: 3px solid #141210; display: block; }
</style>
<h1>出图质感对照</h1>
<div class="meta">源图 ${esc(basename(photoPath))} ${esc(srcDim)} · seed 42 · ${styles.length} 款 × ${variants.length} 配置</div>
<div class="hint">
  <b>怎么看</b>
  按 1:1 看头发边缘有没有飞散发丝、高光是否跟随原图右上窗光；再看**头发以外**——
  额头痘印、毛孔、脸的宽度有没有被动过。基准 A 的问题是整幅重画（皮肤被磨、脸被削窄、输出降采样），
  所以要先分清「发型不对」和「整图变假」这两件事。
</div>
<div class="src" style="margin-bottom:24px"><img src="source.jpg" alt="源图"><div class="meta">原图</div></div>
<table>
  <tr><td></td>${variants.map((v) => `<th>${esc(v.label)}<span class="why">${esc(v.why)}</span></th>`).join("")}</tr>
${styles
  .map(
    (s) => `  <tr>
    <td class="rowhead">${esc(s.canonicalName)}</td>
${variants
  .map((v) => {
    const c = cells.get(key(s.canonicalName, v.id))!;
    return `    <td><div class="cell">
      ${c.file ? `<img src="${esc(c.file)}" alt="${esc(s.canonicalName)} ${esc(v.id)}">` : `<div class="missing">未生成</div>`}
      <div class="prompt">${esc(c.prompt)}</div>
      <div class="prompt">反向：${esc(c.negative)}</div>
      <div class="foot${c.file ? "" : " fail"}">${esc(c.note)}</div>
    </div></td>`;
  })
  .join("\n")}
  </tr>`,
  )
  .join("\n")}
</table>
`;
writeFileSync(join(OUT_DIR, "index.html"), html);

const ok = [...cells.values()].filter((c) => c.file).length;
console.log(`\n完成 ${ok}/${cells.size}`);
console.log(`对照页：${join(OUT_DIR, "index.html")}`);
process.exit(0);
