import type { ClothingSwapInput, ClothingSwapProvider, ClothingSwapResult } from "./types.js";

/**
 * NOT VIABLE — corrected finding (was previously "blocked on credentials",
 * now confirmed to be a capability gap, not a credentials gap).
 *
 * Inspected the official `tencentcloud-sdk-nodejs-hunyuan` SDK directly:
 * Hunyuan's image APIs are `SubmitHunyuanImageJob` (text-to-image) and
 * `SubmitHunyuanImageChatJob` (multi-turn text-to-image via ChatId context).
 * Neither accepts an input photo to edit/swap — they only generate new
 * images from text prompts. There is no `image`/`InputImage` field on
 * `SubmitHunyuanImageChatJobRequest`. Earlier research claiming Hunyuan has
 * a dedicated "模特换装" (outfit swap) endpoint could not be confirmed
 * against the real SDK and should be treated as unverified/likely incorrect
 * — if such a product exists, it is not part of the Hunyuan brand/SDK.
 *
 * Outfit-swap candidate list is narrowed to Volcengine (图片换装, see
 * volcengineClothingSwap.ts) pending confirmation of its req_key.
 */
export function createHunyuanClothingSwapProvider(): ClothingSwapProvider {
  return {
    name: "hunyuan-outfit-swap",
    async swap(_input: ClothingSwapInput): Promise<ClothingSwapResult> {
      throw new Error(
        "hunyuan-outfit-swap is not viable: the official Hunyuan SDK has no image-editing/outfit-swap " +
          "capability (only text-to-image generation), see file comment for details.",
      );
    },
  };
}
