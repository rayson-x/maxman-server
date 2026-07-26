import "dotenv/config";
import { readFile } from "node:fs/promises";
import { createQwenVisionProvider } from "../features/appearance-agent/providers/vision/qwenVision.js";

const buf = await readFile("test-fixtures/faces/01-round.jpg");
const imageUrl = `data:image/jpeg;base64,${buf.toString("base64")}`;

const provider = createQwenVisionProvider();
try {
  const result = await provider.analyze({ imageUrl, prompt: "请分析这张照片中人物的脸型、发型。只输出JSON。" });
  console.log("SUCCESS:", JSON.stringify(result, null, 2));
} catch (err) {
  console.log("FAILED:", err instanceof Error ? err.message : err);
}
