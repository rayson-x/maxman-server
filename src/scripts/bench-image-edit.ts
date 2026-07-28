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
  /**
   * 覆盖整条正向 prompt。默认 `把这个人的发型改成：<描述> <身份约束>`。
   *
   * 存在的理由：**prompt 结构问题每换一次 provider 就得重测。** SeedEdit 3.0 上
   * 带发型名会让名称先验压倒描述（`微碎盖` 出油头背头，反向 prompt 压不住），
   * 于是现有 15 条描述都是「不带名、纯动作描述」。但那是 SeedEdit 的缺陷，
   * 不能假设新模型也如此——名称有可能反而是正确的锚点。
   */
  buildPrompt?: (a: { name: string; description: string }) => string;
  /**
   * 按发型名替换 renderDescription。用来在**改数据文件之前**先验证候选措辞——
   * 否则每试一版都要动 objectiveHairstyleAttributes.ts 再回滚。
   */
  descriptionOverrides?: Record<string, string>;
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

// ── prompt 结构变体（都跑当前默认 provider = Seedream 4.5）─────────────────
// 回答一个问题：现有 15 条描述「不带发型名」是为绕开 SeedEdit 的名称先验，
// 换 Seedream 4.5 后这个绕法还有必要吗？名称可能反而是正确的锚点。
// 结论决定的是「15 条要不要整体重构」，所以先用 3 款做便宜的判断。
VARIANTS.push(
  {
    id: "N0",
    label: "N0 · 只给描述（现状）",
    why: "现有 15 条的结构：不带发型名，纯动作描述",
    provider: () => arkWith(ARK_DEFAULT),
    negativePrompt: NEGATIVE_PROMPT,
  },
  {
    id: "N1",
    label: "N1 · 发型名 + 描述",
    why: "名称做锚点、描述做细化。若明显更准，15 条都该带上名字",
    provider: () => arkWith(ARK_DEFAULT),
    buildPrompt: ({ name, description }) =>
      `把这个人的发型改成${name}：${description} ${identityConstraint("头发")}`,
    negativePrompt: NEGATIVE_PROMPT,
  },
  {
    id: "N2",
    label: "N2 · 只给发型名",
    why: "对照上限：若它就已经够准，说明我们那些厘米数描述是多余的",
    provider: () => arkWith(ARK_DEFAULT),
    buildPrompt: ({ name }) => `把这个人的发型改成${name} ${identityConstraint("头发")}`,
    negativePrompt: NEGATIVE_PROMPT,
  },
  {
    id: "N3",
    label: "N3 · 名+描述，且钉住姿态",
    why: "N0/N1 在带方向性措辞的款式上会把头转成 3/4 侧脸——验证显式钉住朝向能否消除",
    provider: () => arkWith(ARK_DEFAULT),
    buildPrompt: ({ name, description }) =>
      `把这个人的发型改成${name}：${description} 保持同一个人的脸型、五官与表情不变，` +
      `保持正面视角与原有头部朝向、拍摄角度不变，只改头发`,
    negativePrompt: NEGATIVE_PROMPT,
  },
  {
    id: "P1",
    label: "P1 · 去掉方向措辞，改用解剖锚点",
    why: "假设一：`斜向一侧` 被读成镜头朝向。改成按眉/额角定位分缝，不出现方位词",
    provider: () => arkWith(ARK_DEFAULT),
    descriptionOverrides: {
      三七侧分: "顶部留六到七公分并保持蓬松，分缝线落在左眉正上方，左边头发少右边头发多，较多的一侧压住额角，鬓角剪薄不推光",
      韩式逗号刘海: "刘海留到眉毛，靠左眉那几缕向内弯成逗号形的钩子，额头中间露出来，两侧剪出层次",
    },
    buildPrompt: ({ name, description }) =>
      `把这个人的发型改成${name}：${description} ${identityConstraint("头发")}`,
    negativePrompt: NEGATIVE_PROMPT,
  },
  {
    id: "P2",
    label: "P2 · 姿态约束前置",
    why: "假设二：约束放句尾权重太低。改为开头就钉死正面证件照角度",
    provider: () => arkWith(ARK_DEFAULT),
    buildPrompt: ({ name, description }) =>
      `保持正面平视的证件照角度、头部朝向与拍摄距离完全不变，只替换头发：` +
      `改成${name}，${description}。脸型、五官、表情不变`,
    negativePrompt: NEGATIVE_PROMPT,
  },
  {
    id: "P3",
    label: "P3 · 约束前置，去掉画幅暗示",
    why: "P2 保住了姿态但「证件照」把画幅改成竖版。换成中性措辞，只钉构图不提照片格式",
    provider: () => arkWith(ARK_DEFAULT),
    buildPrompt: ({ name, description }) =>
      `保持原照片的构图、画面比例、头部朝向与拍摄距离完全不变，只替换头发：` +
      `改成${name}，${description}。脸型、五官、表情不变`,
    negativePrompt: NEGATIVE_PROMPT,
  },
  {
    id: "P4",
    label: "P4 · 约束前置 + 精简描述",
    why: "N2（只给名、描述最短）两款都保住姿态——验证描述越短漂移越小",
    provider: () => arkWith(ARK_DEFAULT),
    descriptionOverrides: {
      三七侧分: "顶部六到七公分，蓬松三七分缝，刘海压住额角",
      韩式逗号刘海: "刘海到眉毛，末端弯成逗号钩，额头露出一部分",
    },
    buildPrompt: ({ name, description }) =>
      `保持原照片的构图、画面比例、头部朝向与拍摄距离完全不变，只替换头发：` +
      `改成${name}，${description}。脸型、五官、表情不变`,
    negativePrompt: NEGATIVE_PROMPT,
  },
);

const ARK_DEFAULT = "doubao-seedream-4-5-251128";
const arkWith = (model: string): ImageEditProvider => createArkSeedreamImageEditProvider(model);

const ARK_VARIANT_IDS = ["E", "F", "G", "N0", "N1", "N2", "N3", "P1", "P2", "P3", "P4"];
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
    const baseDesc = v.descriptionOverrides?.[name] ?? style.renderDescription;
    const desc = v.positiveSuffix ? `${baseDesc}，${v.positiveSuffix}` : baseDesc;
    const prompt = v.buildPrompt
      ? v.buildPrompt({ name, description: desc })
      : `把这个人的发型改成：${desc} ${identityConstraint("头发")}`;
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
