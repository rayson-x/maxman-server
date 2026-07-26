import "dotenv/config";
import { readFile, readdir } from "node:fs/promises";
import { createZhipuVisionProvider } from "../features/appearance-agent/providers/vision/zhipuVision.js";
import { createQwenVisionProvider } from "../features/appearance-agent/providers/vision/qwenVision.js";

/**
 * Fact-finding: can the vision providers reliably assess HAIR DENSITY, and do
 * they agree with each other? Density is needed as a hard feasibility filter
 * (sparse hair can't carry volume-dependent styles), so an unreliable or
 * inconsistent signal can't be used as a gate.
 *
 * Prompt is deliberately framed as styling feasibility, never diagnosis.
 */
const FIXTURES_DIR = "test-fixtures/faces";

const PROMPT =
  "请只做造型可行性评估，不要做任何医学诊断、不要提及疾病或脱发症状。只输出JSON，不要输出JSON之外的文字。" +
  "评估这张照片中人物头发的以下属性：\n" +
  "hair_density: 只能取 sparse / medium / dense 三个值之一（头发的整体量感）\n" +
  "crown_coverage: 只能取 full / thinning / visible_scalp 三个值之一（头顶覆盖情况）\n" +
  "hairline_position: 只能取 normal / slightly_back / noticeably_back 三个值之一（发际线位置）\n" +
  "can_support_volume_styles: true 或 false（量感是否足够支撑蓬松堆叠类发型，如纹理烫、飞机头）\n" +
  "confidence: 0 到 1 的数字（你对本次判断的确信程度）\n" +
  '输出格式：{"hair_density":"medium","crown_coverage":"full","hairline_position":"normal","can_support_volume_styles":true,"confidence":0.8}';

function parseJson(raw: string): Record<string, unknown> | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

async function main() {
  const zhipu = createZhipuVisionProvider();
  const qwen = createQwenVisionProvider();

  const files = (await readdir(FIXTURES_DIR)).filter((f) => f.endsWith(".jpg")).sort();

  const rows: string[] = [];
  let agreeDensity = 0;
  let agreeVolume = 0;
  let comparable = 0;

  for (const file of files) {
    const id = file.replace(/\.jpg$/, "");
    const buf = await readFile(`${FIXTURES_DIR}/${file}`);
    const imageUrl = `data:image/jpeg;base64,${buf.toString("base64")}`;

    const [z, q] = await Promise.all([
      zhipu.analyze({ imageUrl, prompt: PROMPT }).catch((e) => ({ rawText: `ERR ${e.message}` })),
      qwen.analyze({ imageUrl, prompt: PROMPT }).catch((e) => ({ rawText: `ERR ${e.message}` })),
    ]);

    const zp = parseJson(z.rawText);
    const qp = parseJson(q.rawText);

    const zd = String(zp?.hair_density ?? "?");
    const qd = String(qp?.hair_density ?? "?");
    const zv = String(zp?.can_support_volume_styles ?? "?");
    const qv = String(qp?.can_support_volume_styles ?? "?");
    const zc = String(zp?.crown_coverage ?? "?");
    const qc = String(qp?.crown_coverage ?? "?");

    if (zd !== "?" && qd !== "?") {
      comparable += 1;
      if (zd === qd) agreeDensity += 1;
      if (zv === qv) agreeVolume += 1;
    }

    const flag = zd === qd ? "  " : "≠ ";
    rows.push(
      `${flag}${id.padEnd(14)} density: zhipu=${zd.padEnd(7)} qwen=${qd.padEnd(7)} | crown: ${zc.padEnd(14)}/${qc.padEnd(14)} | volumeOK: ${zv}/${qv}`,
    );
    console.log(rows[rows.length - 1]);
  }

  console.log(`\n--- Agreement over ${comparable} comparable images ---`);
  console.log(`hair_density identical:             ${agreeDensity}/${comparable}`);
  console.log(`can_support_volume_styles identical: ${agreeVolume}/${comparable}`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
