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
    "用户明确说想看更大胆、更全面的发型改善建议，不只是保守方案。请给出你的完整分析流程和最终建议。",
});

console.log("=== Agent text ===");
console.log(result.text);
console.log("=== Tool calls ===");
console.log(JSON.stringify(result.toolCalls, null, 2));
