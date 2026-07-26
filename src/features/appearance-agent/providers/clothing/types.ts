export interface ClothingSwapInput {
  /** Photo of the person (public URL or base64, provider-dependent). */
  personImageUrl?: string;
  personImageBase64?: string;
  /** Photo of the garment to put on the person. */
  garmentImageUrl?: string;
  garmentImageBase64?: string;
}

export interface ClothingSwapResult {
  provider: string;
  imageUrl?: string;
  imageBase64?: string;
  /** Provider task/call id, for resuming an interrupted poll and for billing reconciliation. */
  callId?: string;
  latencyMs: number;
  raw?: unknown;
}

export interface ClothingSwapProvider {
  readonly name: string;
  swap(input: ClothingSwapInput): Promise<ClothingSwapResult>;
}
