import "dotenv/config";
import { getWeatherAwareAppearanceAgentRunner } from "../features/appearance-agent/composition.js";

const FAKE_ANALYSIS_SUMMARY =
  "面部：圆脸，发际线正常，无明显脱发迹象，发质偏干枯毛躁。" +
  "穿搭：上身穿着宽松T恤，尺寸偏大不合身，颜色偏灰暗与肤色不太协调。";

const result = await getWeatherAwareAppearanceAgentRunner().generate({
  location: {
    province: process.env.TEST_WEATHER_PROVINCE ?? "浙江省",
    city: process.env.TEST_WEATHER_CITY ?? "杭州市",
  },
  prompt:
    `这是用户的视觉分析结果：\n${FAKE_ANALYSIS_SUMMARY}\n\n` +
    "请分别针对发型(hair)和穿搭(outfit_accessory)两个方向，调用工具给出可以发展的候选方向和评分，然后用中文总结给用户看。",
});

console.log("=== Agent text ===");
console.log(result.text);
console.log("=== Tool calls ===");
console.log(JSON.stringify(result.toolCalls, null, 2));
