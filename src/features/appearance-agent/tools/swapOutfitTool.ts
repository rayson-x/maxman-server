import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { ClothingSwapProvider } from "../providers/clothing/types.js";

/**
 * Tool 3/4 — outfit swap for the full-body target image. Distinct from
 * editAppearanceImageTool: this is a specialized garment-fitting model, not
 * generic instruction-based img2img (see design.md's img2img vs
 * clothing-swap distinction).
 */
export function createSwapOutfitTool(provider: ClothingSwapProvider) {
  return createTool({
    id: "swap-outfit",
    description:
      "Put a garment onto the user's photo to produce a full-body outfit target image. Requires a photo of the " +
      "person and a photo of the garment to put on them.",
    inputSchema: z.object({
      personImageUrl: z.string().describe("URL of the user's photo (full body preferred)"),
      garmentImageUrl: z.string().describe("URL of the garment/clothing image to put on the person"),
    }),
    execute: async (inputData) => {
      const result = await provider.swap({
        personImageUrl: inputData.personImageUrl,
        garmentImageUrl: inputData.garmentImageUrl,
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
