import "dotenv/config";
import { createQwenImageEditProvider } from "../features/appearance-agent/providers/imageEdit/qwenImageEdit.js";

const TEST_IMAGE_URL = "https://picsum.photos/id/64/512/512.jpg";

const provider = createQwenImageEditProvider();
try {
  const result = await provider.edit({ imageUrl: TEST_IMAGE_URL, instruction: "把图片调成黑白色调" });
  console.log("SUCCESS:", JSON.stringify(result, null, 2));
} catch (err) {
  console.log("FAILED:", err instanceof Error ? err.message : err);
}
