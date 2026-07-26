export interface TextToImageInput {
  prompt: string;
  /** e.g. "1024x1024" — provider-dependent which sizes are valid. */
  size?: string;
}

export interface TextToImageResult {
  provider: string;
  imageUrl?: string;
  imageBase64?: string;
  latencyMs: number;
  raw?: unknown;
}

export interface TextToImageProvider {
  readonly name: string;
  generate(input: TextToImageInput): Promise<TextToImageResult>;
}
