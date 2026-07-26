import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { ImageEditProvider } from "../providers/imageEdit/types.js";

/**
 * Tool 2/4 — img2img for hairstyle/grooming/skin changes on the ORIGINAL
 * baseline photo (never chained onto a previously generated image — see
 * technical-architecture.md TargetImage.baseline_photo_id note, and
 * design.md decision 5).
 */
export function createEditAppearanceImageTool(provider: ImageEditProvider) {
  return createTool({
    id: "edit-appearance-image",
    description:
      "Generate a face/hair/grooming target image by editing the user's ORIGINAL baseline photo according to a single, " +
      "specific instruction (e.g. 'trim the beard shorter', 'style the top with more volume'). Always pass the ORIGINAL " +
      "baseline photo URL, never a previously generated image — identity/body proportions must be preserved.",
    inputSchema: z.object({
      baselineImageUrl: z.string().describe("URL of the user's ORIGINAL uploaded baseline photo"),
      instruction: z
        .string()
        .describe("A single, specific edit instruction in natural language, <=120 characters recommended"),
    }),
    execute: async (inputData) => {
      const result = await provider.edit({
        imageUrl: inputData.baselineImageUrl,
        instruction: inputData.instruction,
      });
      return {
        provider: result.provider,
        imageUrl: result.imageUrl,
        imageBase64: result.imageBase64,
        callId: result.callId,
      };
    },
  });
}
