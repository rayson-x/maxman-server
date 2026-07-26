import "dotenv/config";
import { getAppearanceAgent } from "../features/appearance-agent/composition.js";

const result = await getAppearanceAgent().generate(
  "帮我生成一张示意图，展示什么是'低卷度渐变短发(low fade)'发型的效果，不需要基于我本人的照片，只是想看看这个发型长什么样。",
);

console.log("=== Agent text ===");
console.log(result.text);
console.log("=== Tool calls ===");
console.log(JSON.stringify(result.toolCalls, null, 2));
