export interface ImageEditInput {
  /** Base64-encoded baseline photo (no data: prefix) or a public image URL, provider-dependent. */
  imageBase64?: string;
  imageUrl?: string;
  /** Instruction describing the desired change (from ChangeManifestEntry text, see prisma/schema.prisma ChangeManifestEntry). */
  instruction: string;
  /** Stable per-plan seed when the active provider supports deterministic edits. */
  seed?: number;
}

export interface ImageEditResult {
  provider: string;
  /** Public URL or base64 of the generated image (provider-dependent). */
  imageUrl?: string;
  imageBase64?: string;
  /** Provider task/call id, for resuming an interrupted poll and for billing reconciliation. */
  callId?: string;
  latencyMs: number;
  raw?: unknown;
}

export interface ImageEditProvider {
  readonly name: string;
  edit(input: ImageEditInput): Promise<ImageEditResult>;
}
