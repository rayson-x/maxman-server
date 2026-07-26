import type { Step } from "./types.js";
import { reviewFreeInput, BLOCKED_MESSAGES } from "../features/appearance-agent/data/domainLexicon.js";

/**
 * S1 输入内容安全（tasks 5.1）。
 *
 * ⚠ 当前形态：**只跑确定性红线规则，不接真实内容安全服务**。
 * 内容安全供应商选型在本地 MVP 阶段有意搁置（tasks 0.1/0.2），上线前必须补上
 * 图片审核（色情/未成年人/非本人/公众人物）与文本审核。
 *
 * 现在能做且必须做的是确定性那一层——它本来就是整个内容安全管道的**最终阻断层**
 * （硬编码红线，不受模型判断影响），不依赖任何外部服务。所以搁置供应商不等于
 * 这一步是空的：用户自由输入的越界请求现在就会被拦住。
 */

export type ModerateInputInput = {
  /** 待审核的用户自由文本（发型/穿搭意向）。无自由输入时为空数组 */
  texts: string[];
  /** 待审核的照片 storageKey。当前不做真实图片审核，只登记待审 */
  photoStorageKeys: string[];
};

export type ModerateInputOutput = {
  textVerdicts: {
    text: string;
    verdict: "in_domain" | "out_of_domain" | "blocked";
    category?: string;
    userMessage?: string;
    matchedTerms?: string[];
  }[];
  /** 图片审核当前一律返回 deferred —— 明确标记"没做"而不是假装通过 */
  photoVerdicts: { storageKey: string; verdict: "deferred_no_provider" }[];
  /** true 表示存在被红线阻断的输入，调用方必须终止后续步骤 */
  hasBlocked: boolean;
};

export const moderateInputStep: Step<ModerateInputInput, ModerateInputOutput> = {
  name: "S1_moderate_input",
  async run(input) {
    const textVerdicts = input.texts.map((text) => {
      const v = reviewFreeInput(text);
      if (v.kind === "blocked") {
        return { text, verdict: "blocked" as const, category: v.category, userMessage: BLOCKED_MESSAGES[v.category], matchedTerms: v.matchedTerms };
      }
      if (v.kind === "out_of_domain") {
        return { text, verdict: "out_of_domain" as const };
      }
      return { text, verdict: "in_domain" as const, matchedTerms: v.matchedTerms };
    });

    const photoVerdicts = input.photoStorageKeys.map((storageKey) => ({
      storageKey,
      verdict: "deferred_no_provider" as const,
    }));

    const hasBlocked = textVerdicts.some((v) => v.verdict === "blocked");

    // 图片审核缺失是已知缺口而非失败——用 completed_partial 显式表达，
    // 这样 job 状态如实反映"这一步没有完整执行"，不会被误读成审核通过
    if (photoVerdicts.length > 0) {
      return {
        status: "completed_partial",
        data: { textVerdicts, photoVerdicts, hasBlocked },
        missing: photoVerdicts.map((p) => ({
          item: `图片审核 ${p.storageKey}`,
          reason: "ImageModerationProvider 尚未选型（tasks 0.1 有意搁置），上线前必须补",
        })),
      };
    }

    return { status: "completed", data: { textVerdicts, photoVerdicts, hasBlocked } };
  },
};
