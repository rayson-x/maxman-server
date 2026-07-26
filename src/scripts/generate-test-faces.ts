import "dotenv/config";
import { Signer } from "@volcengine/openapi";
import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";

const OUT_DIR = "test-fixtures/faces";

const REQ_KEY = "high_aes_general_v21_L";
const HOST = process.env.VOLC_VISUAL_HOST ?? "visual.volcengineapi.com";

const PROMPTS: Array<{ id: string; label: string; prompt: string }> = [
  {
    id: "01-round",
    label: "圆脸",
    prompt: "证件照风格，正面视角，一位28岁中国男性，圆脸，短发，白色衬衫，纯白背景，自然光线，面部细节清晰",
  },
  {
    id: "02-square",
    label: "方脸",
    prompt: "证件照风格，正面视角，一位35岁中国男性，方脸，下颌线明显方正，寸头，白色衬衫，纯白背景，自然光线",
  },
  {
    id: "03-long",
    label: "长脸",
    prompt: "证件照风格，正面视角，一位30岁中国男性，长脸，脸型偏窄偏长，中分发型，白色衬衫，纯白背景，自然光线",
  },
  {
    id: "04-oval",
    label: "瓜子脸/鹅蛋脸",
    prompt: "证件照风格，正面视角，一位25岁中国男性，瓜子脸，下巴较尖，五官精致，偏分发型，白色衬衫，纯白背景",
  },
  {
    id: "05-guozi",
    label: "国字脸",
    prompt: "证件照风格，正面视角，一位40岁中国男性，国字脸，脸型方正宽阔，轮廓分明，短发，白色衬衫，纯白背景",
  },
  {
    id: "06-youzi",
    label: "由字脸",
    prompt: "证件照风格，正面视角，一位33岁中国男性，由字脸，额头窄，下颌较宽，寸头，白色衬衫，纯白背景，自然光线",
  },
  {
    id: "07-jiazi",
    label: "甲字脸",
    prompt: "证件照风格，正面视角，一位27岁中国男性，甲字脸，额头宽阔，下巴较窄尖，短发，白色衬衫，纯白背景",
  },
  {
    id: "08-glasses",
    label: "圆脸+眼镜",
    prompt: "证件照风格，正面视角，一位45岁中国男性，圆脸，戴黑框眼镜，头发花白，白色衬衫，纯白背景，自然光线",
  },
  {
    id: "09-beard",
    label: "方脸+胡须",
    prompt: "证件照风格，正面视角，一位38岁中国男性，方脸，留有短胡须，浓眉，白色衬衫，纯白背景，自然光线",
  },
  {
    id: "10-receding",
    label: "长脸+发际线后移",
    prompt: "证件照风格，正面视角，一位50岁中国男性，长脸，发际线明显后移，头顶头发稀疏，白色衬衫，纯白背景，自然光线",
  },
];

async function submitTask(prompt: string): Promise<string> {
  const accessKeyId = process.env.VOLC_ACCESS_KEY_ID!;
  const secretKey = process.env.VOLC_SECRET_ACCESS_KEY!;
  const body = JSON.stringify({ req_key: REQ_KEY, prompt, width: 512, height: 512 });
  const requestData = {
    region: "cn-north-1",
    method: "POST",
    params: { Action: "CVSync2AsyncSubmitTask", Version: "2022-08-31" },
    headers: { Host: HOST, "Content-Type": "application/json" },
    body,
  };
  const signer = new Signer(requestData, "cv");
  signer.addAuthorization({ accessKeyId, secretKey });
  const url = `https://${HOST}/?Action=CVSync2AsyncSubmitTask&Version=2022-08-31`;
  const res = await fetch(url, { method: "POST", headers: requestData.headers as Record<string, string>, body });
  const json = (await res.json()) as { code: number; data?: { task_id: string }; message?: string };
  if (json.code !== 10000 || !json.data?.task_id) throw new Error(`Submit failed: ${JSON.stringify(json)}`);
  return json.data.task_id;
}

async function pollResult(taskId: string): Promise<string> {
  const accessKeyId = process.env.VOLC_ACCESS_KEY_ID!;
  const secretKey = process.env.VOLC_SECRET_ACCESS_KEY!;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const body = JSON.stringify({ req_key: REQ_KEY, task_id: taskId, req_json: JSON.stringify({ return_url: true }) });
    const requestData = {
      region: "cn-north-1",
      method: "POST",
      params: { Action: "CVSync2AsyncGetResult", Version: "2022-08-31" },
      headers: { Host: HOST, "Content-Type": "application/json" },
      body,
    };
    const signer = new Signer(requestData, "cv");
    signer.addAuthorization({ accessKeyId, secretKey });
    const url = `https://${HOST}/?Action=CVSync2AsyncGetResult&Version=2022-08-31`;
    const res = await fetch(url, { method: "POST", headers: requestData.headers as Record<string, string>, body });
    const json = (await res.json()) as {
      code: number;
      data?: { status: string; image_urls?: string[] };
      message?: string;
    };
    if (json.data?.status === "done") {
      const url = json.data.image_urls?.[0];
      if (!url) throw new Error(`No image_urls in done result: ${JSON.stringify(json)}`);
      return url;
    }
    if (json.code !== 10000) throw new Error(`Poll failed: ${JSON.stringify(json)}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Timed out waiting for task ${taskId}`);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const manifest: Array<{ id: string; label: string; file: string; sourceUrl: string }> = [];

  for (const { id, label, prompt } of PROMPTS) {
    const file = `${OUT_DIR}/${id}.jpg`;
    if (existsSync(file)) {
      console.log(`[${id}] ${label} — already exists, skipping`);
      manifest.push({ id, label, file, sourceUrl: "(pre-existing, url not recorded)" });
      continue;
    }
    process.stdout.write(`[${id}] ${label} — submitting... `);
    const taskId = await submitTask(prompt);
    process.stdout.write(`task=${taskId} polling... `);
    const url = await pollResult(taskId);
    const res = await fetch(url);
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(file, buf);
    manifest.push({ id, label, file, sourceUrl: url });
    console.log(`saved -> ${file}`);
  }

  await writeFile(`${OUT_DIR}/manifest.json`, JSON.stringify(manifest, null, 2));
  console.log(`\nAll done. Manifest written to ${OUT_DIR}/manifest.json`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
