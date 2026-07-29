export interface VisionAnalysisInput {
  /** Data URL or public URL of the image to analyze. */
  imageUrl: string;
  /** Instruction describing what structured analysis to produce. */
  prompt: string;
}

export interface VisionAnalysisResult {
  provider: string;
  model: string;
  /** Raw text response from the model (expected to be JSON per the prompt's instruction). */
  rawText: string;
  latencyMs: number;
  usage?: unknown;
}

export interface VisionAnalysisProvider {
  readonly name: string;
  analyze(input: VisionAnalysisInput): Promise<VisionAnalysisResult>;
}
