import "dotenv/config";
import { env, required } from "../config/env.js";

const res = await fetch(`${env.zhipu.baseURL}/images/generations`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${required("ZHIPU_API_KEY")}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "cogview-3-flash",
    prompt: "一只可爱的橘猫坐在窗台上，阳光明媚，卡通风格",
    size: "1024x1024",
  }),
});

console.log("status:", res.status);
console.log(JSON.stringify(await res.json(), null, 2));
