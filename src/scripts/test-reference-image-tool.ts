import "dotenv/config";
import { getWeatherAwareAppearanceAgentRunner } from "../features/appearance-agent/composition.js";

const result = await getWeatherAwareAppearanceAgentRunner().generate({
  location: {
    province: process.env.TEST_WEATHER_PROVINCE ?? "浙江省",
    city: process.env.TEST_WEATHER_CITY ?? "杭州市",
  },
  prompt:
    "帮我生成一张示意图，展示什么是'低卷度渐变短发(low fade)'发型的效果，不需要基于我本人的照片，只是想看看这个发型长什么样。",
});

console.log("=== Agent text ===");
console.log(result.text);
console.log("=== Tool calls ===");
console.log(JSON.stringify(result.toolCalls, null, 2));
