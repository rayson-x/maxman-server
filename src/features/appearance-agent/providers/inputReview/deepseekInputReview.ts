import { generateObject } from "ai";
import { z } from "zod";
import { createDeepSeekModel } from "../llm/deepseekModel.js";
import type { InputReviewInput, InputReviewProvider, InputReviewResult } from "./types.js";

const VERDICT_SCHEMA = z.object({
  allowed: z.boolean(),
  violationCategory: z
    .enum(["facial_structure", "identity_attribute", "impersonation", "body_enhancement", "out_of_scope", "none"]),
  userMessage: z.string(),
  reasoning: z.string(),
});

/**
 * 第二层越界审核（tasks 4.2）。
 *
 * prompt 里必须出现字面的 "JSON" —— DeepSeek 的 API 会在缺少该词时硬拒绝
 * `response_format: json_object`（本项目已踩过这个坑）。同时必须给出精确的
 * 字段示例：`json_object` 不做 schema 语法约束，模型会自行发挥字段名与嵌套。
 */
export function createDeepSeekInputReviewProvider(): InputReviewProvider {
  const model = createDeepSeekModel();

  return {
    name: "deepseek-input-review",
    async review(input: InputReviewInput): Promise<InputReviewResult> {
      const start = Date.now();
      const { object } = await generateObject({
        model,
        schema: VERDICT_SCHEMA,
        prompt:
          "你是形象改善产品的输入审核员，只输出JSON，不要输出JSON之外的任何文字，也不要用markdown代码块包裹。\n\n" +
          "产品能力边界：只做**发型、仪容、穿搭**层面的改善，生成的效果图必须保留用户本人的" +
          "脸型骨骼、五官比例、性别、年龄、种族。\n\n" +
          "必须拒绝的类别：\n" +
          "- facial_structure：要求改变脸型/骨骼/五官比例（削骨、垫下巴、隆鼻、改脸型、把眼睛变大等）\n" +
          "- identity_attribute：要求改变性别/年龄/种族（变成女生、变年轻十岁、换成欧美脸等）\n" +
          "- impersonation：要求变成某个具体真人的样子\n" +
          "- body_enhancement：要求在效果图上凭空增加肌肉/身高/减脂效果\n" +
          "- out_of_scope：与发型穿搭完全无关的请求\n\n" +
          "必须放行的（这些是产品的核心业务，误拒等于砍功能）：\n" +
          "- 通过发型/穿搭达到**视觉修饰**效果：显小脸、显高、显瘦、显精神、修饰脸型、遮盖发际线\n" +
          "- 描述想要的发型款式、发色、服装品类、风格方向、场合需求\n" +
          "- 表达对现状的不满（觉得自己土/邋遢/没精神）\n\n" +
          "关键区分：「**看起来**更高」是穿搭能做到的，放行；「把腿**拉长**」是要改身体，拒绝。" +
          "「用发型显小脸」放行；「把脸削小」拒绝。\n\n" +
          `用户输入：「${input.text}」\n` +
          `第一层词库匹配到的领域词：${input.matchedDomainTerms.join("、") || "（无）"}\n\n` +
          "userMessage 写给用户看：放行时留空字符串；拒绝时说明产品边界，不要指责用户，" +
          "并尽量给一个可行的替代方向。reasoning 写你的判断依据（内部审计用）。\n\n" +
          "输出必须严格符合这个JSON结构：\n" +
          '{"allowed":true,"violationCategory":"none","userMessage":"","reasoning":"判断依据"}',
      });

      return {
        provider: "deepseek-input-review",
        verdict: {
          allowed: object.allowed,
          violationCategory: object.violationCategory === "none" ? null : object.violationCategory,
          userMessage: object.userMessage,
          reasoning: object.reasoning,
        },
        latencyMs: Date.now() - start,
        raw: object,
      };
    },
  };
}
