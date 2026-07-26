import "dotenv/config";
import { createDeepSeekTextPlanningProvider } from "../features/appearance-agent/providers/textPlanning/deepseekTextPlanning.js";
import { getRecommendedCatalogEntries } from "../features/appearance-agent/data/candidateTaskCatalog.js";

const provider = createDeepSeekTextPlanningProvider();
try {
  const result = await provider.scoreCandidates({
    analysisSummary: "圆脸，发质偏干枯毛躁，T恤偏大不合身，颜色灰暗与肤色不协调。",
    candidates: getRecommendedCatalogEntries("hair"),
  });
  console.log("SUCCESS:", JSON.stringify(result, null, 2));
} catch (err) {
  console.log("FAILED:", err);
}
