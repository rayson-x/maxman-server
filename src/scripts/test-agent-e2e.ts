import "dotenv/config";
import { getWeatherAwareAppearanceAgentRunner } from "../features/appearance-agent/composition.js";

const TEST_PHOTO = "https://picsum.photos/id/64/512/512.jpg";
const TEST_LOCATION = {
  province: process.env.TEST_WEATHER_PROVINCE ?? "浙江省",
  city: process.env.TEST_WEATHER_CITY ?? "杭州市",
};

const result = await getWeatherAwareAppearanceAgentRunner().generate({
  location: TEST_LOCATION,
  prompt:
    `这是用户的原始基准照片：${TEST_PHOTO}\n` +
    "请调用工具，把头顶头发改造得更蓬松一些，生成一张效果图，然后告诉我调用了哪个工具、结果图片链接是什么。",
});

console.log("=== Agent text ===");
console.log(result.text);
console.log("=== Tool calls ===");
console.log(JSON.stringify(result.toolCalls, null, 2));
