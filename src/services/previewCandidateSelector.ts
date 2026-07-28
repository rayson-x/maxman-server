export type RenderablePreviewCandidate = {
  id: string;
  nameZh: string;
  renderInstruction: string;
  modelRationale?: string;
};

/** Image generation is optional and expensive: only explicitly calibrated candidates enter the batch. */
export function selectRenderablePreviewCandidates<T extends RenderablePreviewCandidate>(
  candidates: T[],
  limit = 3,
): T[] {
  return candidates.filter((candidate) => candidate.renderInstruction.trim().length > 0).slice(0, limit);
}
