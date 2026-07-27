import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFirstRoundPrompt,
  buildOutfitPrompt,
  createHairstyleMultimodalAgentProvider,
} from "./multimodalAgentRecommendation.js";

test("首轮 provider 用一次 tool 输出同时携带人脸结论、风格和发型候选", async () => {
  let receivedPrompt = "";
  const provider = createHairstyleMultimodalAgentProvider({
    invokeFirstRound: async ({ prompt }) => {
      receivedPrompt = prompt;
      return {
        callId: "first-round-call",
        output: {
          faceAnalysis: {
            narrative: "轮廓与当前发型的关系清晰，建议从自然层次开始。",
            structuredSemantic: {
              currentHairstyle: "短发",
              hairlineVisibility: "occluded",
              skinTone: "中性偏暖",
            },
          },
          styleRecommendations: [
            { id: "clean-fit", nameZh: "干净简约", description: "利落基础款", rationale: "适合日常落地" },
            { id: "soft-youth", nameZh: "轻柔少年", description: "自然层次", rationale: "保留亲和感" },
            { id: "urban-commuter", nameZh: "都市通勤", description: "简洁克制", rationale: "适配正式场景" },
          ],
          hairstyleSuggestions: [{
            nameZh: "法式碎盖",
            description: "自然碎发短层次",
            modelRationale: "额前层次与整体比例协调",
          }],
        },
      };
    },
  });

  const result = await provider.recommend({
    photoReadUrl: "https://signed.example/front.jpg",
    geometry: { faceShape: "round" },
    hairSignals: { hairline: "receding", volume: "thin" },
    clientSignals: { cheekboneCoverageNeed: { value: "high" } },
    requestedCount: 3,
  });

  assert.equal(result.callId, "first-round-call");
  assert.equal(result.candidates[0]?.nameZh, "法式碎盖");
  assert.notEqual(result.candidates[0]?.visualDirection, undefined);
  assert.equal(result.firstRound.styleRecommendations.length, 3);
  assert.equal(result.firstRound.faceAnalysis.structuredSemantic.hairlineVisibility, "occluded");
  assert.match(receivedPrompt, /新增客户端风格信号/);
  assert.match(receivedPrompt, /submit_first_round/);
  assert.match(receivedPrompt, /不提供族裔分类/);
});

test("第二轮穿搭 prompt 接收已选风格、首轮人脸结论和全量目录参考", () => {
  const prompt = buildOutfitPrompt({
    selectedStyle: { id: "clean-fit", nameZh: "干净简约" },
    face: { geometry: { faceShape: "round" }, semantics: { skinTone: "中性" } },
    catalogVariants: [{ nameZh: "针织直筒", styleVector: { formality: 5 } }],
  });

  assert.match(prompt, /clean-fit/);
  assert.match(prompt, /skinTone/);
  assert.match(prompt, /针织直筒/);
  assert.match(prompt, /submit_outfit_recommendations/);
  assert.match(prompt, /不.*确定性向量过滤/);
});

test("首轮 prompt 把缺少几何测量定义为不可补判，而不是让模型臆测", () => {
  const prompt = buildFirstRoundPrompt({ geometry: { faceShape: null } });
  assert.match(prompt, /不要补判客户端未提供的几何值/);
});
