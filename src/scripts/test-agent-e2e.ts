import "dotenv/config";
import { getAppearanceAgent } from "../features/appearance-agent/composition.js";

const TEST_PHOTO = "https://picsum.photos/id/64/512/512.jpg";

const result = await getAppearanceAgent().generate(
  `这是用户的原始基准照片：${TEST_PHOTO}\n` +
    "请调用工具，把头顶头发改造得更蓬松一些，生成一张效果图，然后告诉我调用了哪个工具、结果图片链接是什么。",
);

console.log("=== Agent text ===");
console.log(result.text);
console.log("=== Tool calls ===");
console.log(JSON.stringify(result.toolCalls, null, 2));
