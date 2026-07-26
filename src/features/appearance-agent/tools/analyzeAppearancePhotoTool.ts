import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { VisionAnalysisProvider } from "../providers/vision/types.js";

/**
 * Tool 1/4 — visual analysis. The agent "brain" cannot see images itself
 * (design.md decision 16); it calls this tool to get a structured text
 * description of the user's photo, which it then reasons about.
 *
 * Takes its provider as a constructor argument (DI) rather than reaching
 * into a global registry — the composition root decides which concrete
 * vendor to inject.
 */
export function createAnalyzeAppearancePhotoTool(provider: VisionAnalysisProvider) {
  return createTool({
    id: "analyze-appearance-photo",
    description:
      "Analyze a user's uploaded photo (face/hair/skin/posture/outfit) and return a structured JSON description. " +
      "Use this before reasoning about what appearance changes to recommend — you cannot see the image directly.",
    inputSchema: z.object({
      imageUrl: z.string().describe("Public URL of the photo to analyze"),
      focus: z
        .string()
        .describe("What aspect to focus the analysis on, e.g. 'face shape and hairline' or 'current outfit fit'"),
    }),
    execute: async (inputData) => {
      const result = await provider.analyze({
        imageUrl: inputData.imageUrl,
        prompt:
          `请分析这张照片，重点关注：${inputData.focus}。` +
          "只输出结构化JSON，不要输出多余的解释文字。JSON字段应描述观察到的具体特征，不要做医学诊断，不要评判性描述。",
      });
      return {
        provider: result.provider,
        analysis: result.rawText,
      };
    },
  });
}
