import type { FastifyBaseLogger } from "fastify";
import {
  BLOCKED_MESSAGES,
  reviewFreeInput,
} from "../features/appearance-agent/data/domainLexicon.js";
import { getInputReviewProvider } from "../features/appearance-agent/composition.js";

/**
 * 用户自由输入的双层审核。
 *
 * 从 `POST /intake/hair-intent` 抽出来共用：发型意向与自定义风格方向走的是
 * **同一条审核链路**，各自复制一份必然分叉（其中的降级取舍尤其容易抄漏）。
 *
 * 两层都必需：第一层词库拦无歧义越界（模型可能被迂回表述说服，规则不会），
 * 第二层 LLM 判有歧义的、以及词库覆盖不到的新说法（词库按设计不可能穷尽中文）。
 */
export type FreeTextReviewResult =
  | { accepted: true; layer1Kind: "in_domain" | "out_of_domain"; secondLayerReviewed: boolean }
  | {
      accepted: false;
      status: 422;
      reason: "blocked" | "out_of_domain" | "blocked_by_review";
      category?: string | null;
      message: string;
      layer?: 2;
      reviewUnavailable?: boolean;
    };

export async function reviewUserFreeText(
  text: string,
  log: FastifyBaseLogger,
): Promise<FreeTextReviewResult> {
  const verdict = reviewFreeInput(text);

  if (verdict.kind === "blocked") {
    return {
      accepted: false,
      status: 422,
      reason: "blocked",
      category: verdict.category,
      message: BLOCKED_MESSAGES[verdict.category],
    };
  }

  /*
   * ⚠ `out_of_domain` **不终止**，继续进第二层。
   * 早先把它当终止条件，导致「想让下颌线条看起来更清晰立体」这类越界但用视觉修饰
   * 措辞、且不含造型词汇的输入全被判 out_of_domain，用户收到答非所问的回复，
   * 而真正该判断它的第二层被跳过。根因是把强信号（blocked，无歧义）与
   * 弱信号（out_of_domain，词库必然不全）做成了同级终止条件。
   */
  const layer1Kind = verdict.kind;
  const matchedTerms = layer1Kind === "in_domain" ? verdict.matchedTerms : [];

  try {
    const review = await getInputReviewProvider().review({ text, matchedDomainTerms: matchedTerms });
    const v = review.verdict;
    if (!v.allowed) {
      const isOffTopic = v.violationCategory === "out_of_scope";
      return {
        accepted: false,
        status: 422,
        reason: isOffTopic ? "out_of_domain" : "blocked_by_review",
        category: v.violationCategory,
        message:
          v.userMessage
          || (isOffTopic
            ? "没太理解你说的方向，可以换个说法描述你想要的风格吗？"
            : "这个方向超出了我们能做的范围。"),
        layer: 2,
      };
    }
    return { accepted: true, layer1Kind, secondLayerReviewed: true };
  } catch (err) {
    /*
     * 第二层不可用时的降级取舍，按第一层结果分两种：
     *   in_domain     → 放行并标记未审。第一层已拦住无歧义越界，剩下是灰区；
     *                   因审核服务抖动拒掉用户正常的诉求代价更高，
     *                   且下游生成还有身份保留硬约束兜底。
     *   out_of_domain → 拒绝。既没命中领域词，也无第二层背书，没有任何证据
     *                   表明它在业务范畴内，放行只会把垃圾输入送进生成环节。
     */
    log.warn({ err }, "第二层 LLM 审核不可用，按第一层结果降级处理");
    if (layer1Kind === "out_of_domain") {
      return {
        accepted: false,
        status: 422,
        reason: "out_of_domain",
        message: "没太理解你说的方向，可以换个说法描述你想要的风格吗？比如「想显得精神一点」「偏商务一些」。",
        reviewUnavailable: true,
      };
    }
    return { accepted: true, layer1Kind, secondLayerReviewed: false };
  }
}
