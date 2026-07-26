import "dotenv/config";
import { createVolcengineImageEditProvider } from "../features/appearance-agent/providers/imageEdit/volcengineImageEdit.js";

// A real, reasonably-sized photo — the earlier failure (code 50215, "Input
// invalid for this service") turned out to be caused by using a trivial
// 64x64 solid-color test PNG, not an auth/request-shape bug.
const TEST_IMAGE_URL = "https://picsum.photos/id/64/512/512.jpg";

const provider = createVolcengineImageEditProvider();
try {
  const result = await provider.edit({
    imageUrl: TEST_IMAGE_URL,
    instruction: "把背景变成蓝色",
  });
  console.log("SUCCESS:", JSON.stringify({ ...result, raw: undefined }, null, 2));
} catch (err) {
  console.log("ERROR:", err instanceof Error ? err.message : String(err));
}
