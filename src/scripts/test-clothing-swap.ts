import "dotenv/config";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { Signer } from "@volcengine/openapi";
import { createVolcengineClothingSwapProvider } from "../features/appearance-agent/providers/clothing/volcengineClothingSwap.js";
import { uploadBufferToOSS, isOSSConfigured } from "../lib/ossUpload.js";

const T2I_REQ_KEY = "high_aes_general_v21_L";
const HOST = process.env.VOLC_VISUAL_HOST ?? "visual.volcengineapi.com";
const OUT_DIR = "test-fixtures/clothing-swap";

async function submitT2I(prompt: string): Promise<string> {
  const accessKeyId = process.env.VOLC_ACCESS_KEY_ID!;
  const secretKey = process.env.VOLC_SECRET_ACCESS_KEY!;
  const body = JSON.stringify({ req_key: T2I_REQ_KEY, prompt, width: 512, height: 768 });
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

async function pollT2I(taskId: string): Promise<string> {
  const accessKeyId = process.env.VOLC_ACCESS_KEY_ID!;
  const secretKey = process.env.VOLC_SECRET_ACCESS_KEY!;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const body = JSON.stringify({ req_key: T2I_REQ_KEY, task_id: taskId, req_json: JSON.stringify({ return_url: true }) });
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
    const json = (await res.json()) as { code: number; data?: { status: string; image_urls?: string[] }; message?: string };
    if (json.data?.status === "done") {
      const url = json.data.image_urls?.[0];
      if (!url) throw new Error(`No image_urls: ${JSON.stringify(json)}`);
      return url;
    }
    if (json.code !== 10000) throw new Error(`Poll failed: ${JSON.stringify(json)}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Timed out waiting for task ${taskId}`);
}

async function generateAndSave(id: string, prompt: string): Promise<string> {
  const file = `${OUT_DIR}/${id}.jpg`;
  if (existsSync(file)) {
    console.log(`[${id}] already exists, skipping generation`);
    return file;
  }
  console.log(`[${id}] submitting...`);
  const taskId = await submitT2I(prompt);
  console.log(`[${id}] task=${taskId} polling...`);
  const url = await pollT2I(taskId);
  const res = await fetch(url);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(file, buf);
  console.log(`[${id}] saved -> ${file}`);
  return file;
}

// Volcengine's img2img/edit endpoints need a publicly reachable URL, so we
// re-upload the two locally-generated test images to our own OSS bucket
// rather than passing local file paths.
async function uploadPublic(file: string): Promise<string> {
  const buf = await readFile(file);
  const key = `betterMeet-test-fixtures/clothing-swap/${file.split("/").pop()}`;
  return uploadBufferToOSS(key, buf);
}

async function main() {
  if (!isOSSConfigured()) {
    throw new Error(
      "Aliyun OSS is not configured — fill in ALIYUN_OSS_ACCESS_KEY_ID/ACCESS_KEY_SECRET/BUCKET/REGION in .env first",
    );
  }
  await mkdir(OUT_DIR, { recursive: true });

  const modelFile = await generateAndSave(
    "model",
    "全身照，一位25岁中国男性模特，站姿，正面视角，穿着简单的白色圆领T恤和黑色长裤，纯灰色背景，摄影棚灯光，高清",
  );
  const garmentFile = await generateAndSave(
    "garment",
    "产品摄影，一件红色格纹长袖衬衫平铺在白色背景上，服装电商展示图，无人物，高清",
  );

  console.log("Uploading test images to a public host so Volcengine can fetch them...");
  const [modelUrl, garmentUrl] = await Promise.all([uploadPublic(modelFile), uploadPublic(garmentFile)]);
  console.log("modelUrl:", modelUrl);
  console.log("garmentUrl:", garmentUrl);

  const provider = createVolcengineClothingSwapProvider();
  console.log("\nCalling clothing swap provider...");
  const result = await provider.swap({ personImageUrl: modelUrl, garmentImageUrl: garmentUrl });
  console.log("\n=== Result ===");
  console.log(JSON.stringify(result, null, 2));

  if (result.imageUrl) {
    const res = await fetch(result.imageUrl);
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(`${OUT_DIR}/result.png`, buf);
    console.log(`\nSaved result -> ${OUT_DIR}/result.png`);
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
