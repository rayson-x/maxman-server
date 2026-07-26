import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { TextToImageProvider } from "../providers/textToImage/types.js";

/**
 * Tool 4/4 — pure text-to-image, no input photo. For illustrative reference
 * images only (e.g. "what does a low fade haircut look like"), never as a
 * substitute for editAppearanceImageTool/swapOutfitTool: it does not use or
 * preserve the user's own photo, so its output must never be presented as a
 * personalized target image.
 */
export function createGenerateReferenceImageTool(provider: TextToImageProvider) {
  return createTool({
    id: "generate-reference-image",
    description:
      "Generate an illustrative reference image from a text description alone (no input photo, identity not preserved). " +
      "Use only to visually illustrate a general concept (e.g. a hairstyle or garment style) — never as a personalized " +
      "target image for the user; for that, use edit-appearance-image or swap-outfit instead.",
    inputSchema: z.object({
      prompt: z.string().describe("Text description of the image to generate"),
      size: z.string().optional().describe("Image size, e.g. '1024x1024'"),
    }),
    execute: async (inputData) => {
      const result = await provider.generate({ prompt: inputData.prompt, size: inputData.size });
      return {
        provider: result.provider,
        imageUrl: result.imageUrl,
        imageBase64: result.imageBase64,
      };
    },
  });
}
