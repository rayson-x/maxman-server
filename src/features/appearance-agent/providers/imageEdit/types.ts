export interface ImageEditInput {
  /** Base64-encoded baseline photo (no data: prefix) or a public image URL, provider-dependent. */
  imageBase64?: string;
  imageUrl?: string;
  /** Instruction describing the desired change (from ChangeManifestEntry text, see prisma/schema.prisma ChangeManifestEntry). */
  instruction: string;
  /**
   * 约束项。放这里而不是拼进 `instruction`：扩散类编辑模型对正向 prompt 里的
   * 否定式（"不要改变…"）处理很弱，有时反而会把被否定的对象拉进注意力；
   * 而正向 prompt 的长度预算又很紧（SeedEdit 建议 ≤120 字符），
   * 以前 75 字符的身份保持后缀吃掉了约 68% 的预算，把真正要画的造型描述挤到只剩 30 余字。
   */
  negativePrompt?: string;
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
