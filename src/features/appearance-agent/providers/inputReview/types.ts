/**
 * 第二层审核：LLM 越界判断（tasks 4.2）。
 *
 * 与第一层（词库确定性匹配）的分工：
 *   第一层 → 拦住**无歧义**的越界请求（"削骨"、"变成女生"），零成本、可审计
 *   第二层 → 判断**有歧义**的表述，以及第一层词库覆盖不到的新说法
 *
 * 第一层已阻断的输入不会到这里（红线优先且终止）。所以第二层的职责是
 * "第一层放过来的，再看一眼有没有实质越界"——它是补充而非替代。
 *
 * 为什么不能只靠第二层：模型可能被说服（prompt injection、迂回表述），
 * 规则不会。为什么不能只靠第一层：中文表述空间无穷，词库必然有遗漏。
 */

export type InputReviewInput = {
  /** 用户自由输入的原文 */
  text: string;
  /** 第一层匹配到的领域词，作为上下文帮助模型判断 */
  matchedDomainTerms: string[];
};

export type InputReviewVerdict = {
  /** 是否放行 */
  allowed: boolean;
  /** 越界类别；allowed=true 时为 null */
  violationCategory:
    | "facial_structure"
    | "identity_attribute"
    | "impersonation"
    | "body_enhancement"
    | "out_of_scope"
    | null;
  /** 给用户看的说明。拒绝时必须有 */
  userMessage: string;
  /** 模型的判断理由，用于审计与词库迭代——第二层拦下的表述应回补进第一层词库 */
  reasoning: string;
};

export type InputReviewResult = {
  provider: string;
  verdict: InputReviewVerdict;
  latencyMs: number;
  raw?: unknown;
  usage?: unknown;
};

export interface InputReviewProvider {
  readonly name: string;
  review(input: InputReviewInput): Promise<InputReviewResult>;
}
