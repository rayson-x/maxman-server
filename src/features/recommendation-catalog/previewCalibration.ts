import { recommendationCatalogSnapshot } from "./deploymentSnapshot.js";

type PreviewCalibration = {
  hairstyleId: string;
  provider: string;
  model: string;
  calibrationStatus: string;
  renderSpecVersion: string;
  renderInstruction: string;
};

type PreviewCalibrationDocument = { entries?: PreviewCalibration[] };

/**
 * Image rendering is an allow-list, not a best-effort name match. A candidate
 * must have been accepted for this exact provider/model and its exact stable
 * catalog id, otherwise the recommendation remains text-only.
 */
export function resolveHairstylePreviewCalibration(input: {
  hairstyleId: string;
  provider: string;
  model: string;
}): Pick<PreviewCalibration, "renderInstruction" | "renderSpecVersion"> | null {
  const document = recommendationCatalogSnapshot.hairstylePreviewCalibrations as PreviewCalibrationDocument;
  const entry = document.entries?.find((row) =>
    row.hairstyleId === input.hairstyleId &&
    row.provider === input.provider &&
    row.model === input.model &&
    row.calibrationStatus === "render_validated" &&
    row.renderInstruction.trim().length > 0 &&
    row.renderSpecVersion.trim().length > 0,
  );
  return entry
    ? { renderInstruction: entry.renderInstruction, renderSpecVersion: entry.renderSpecVersion }
    : null;
}
