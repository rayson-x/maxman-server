import type { HairSignals } from "../rules/hairConstraints.js";

export type StructuredSemanticAnalysis = {
  currentHairstyle?: string;
  hairlineVisibility?: "visible" | "occluded";
  facialHair?: string;
  glasses?: string;
  skinTone?: string;
  currentOutfit?: string;
};

const MAX_RAW_LENGTH = 16_000;
const MAX_VALUE_LENGTH = 200;

const FIELD_MAP = {
  current_hairstyle: "currentHairstyle",
  hairline_visibility: "hairlineVisibility",
  facial_hair: "facialHair",
  glasses: "glasses",
  skin_tone: "skinTone",
  current_outfit: "currentOutfit",
} as const;

function boundedText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_VALUE_LENGTH) return undefined;
  return trimmed;
}

function normalizeFields(source: Record<string, unknown>): StructuredSemanticAnalysis {
  const output: StructuredSemanticAnalysis = {};
  for (const [providerKey, resultKey] of Object.entries(FIELD_MAP)) {
    const value = boundedText(source[providerKey]);
    if (!value) continue;
    if (resultKey === "hairlineVisibility") {
      const normalized = value.toLowerCase();
      if (normalized === "visible" || normalized === "occluded") {
        output.hairlineVisibility = normalized;
      }
      continue;
    }
    output[resultKey] = value;
  }
  return output;
}

/**
 * Provider output is untrusted and may be JSON, fenced JSON, or a simple
 * key/value list. Only the six requested semantic fields cross this boundary.
 */
export function parseSemanticAnalysis(raw: string): StructuredSemanticAnalysis {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_RAW_LENGTH) return {};
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1] ?? trimmed;

  try {
    const parsed = JSON.parse(fenced) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return normalizeFields(parsed as Record<string, unknown>);
    }
  } catch {
    // Some vision providers occasionally return the requested fields as lines.
  }

  const fields: Record<string, unknown> = {};
  for (const line of fenced.split(/\r?\n/).slice(0, 30)) {
    const match = line.match(
      /^\s*(current_hairstyle|hairline_visibility|facial_hair|glasses|skin_tone|current_outfit)\s*[:：]\s*(.*?)\s*[,，]?\s*$/i,
    );
    if (match) fields[match[1].toLowerCase()] = match[2].replace(/^["']|["']$/g, "");
  }
  return normalizeFields(fields);
}

/**
 * A cloud observation of occlusion supplies the missing signal that the local
 * landmark classifier cannot reliably infer. A cloud "visible" result does
 * not overwrite a stronger client-side high/receding measurement.
 */
export function applySemanticHairlineVisibility(
  signals: HairSignals,
  semantic: StructuredSemanticAnalysis,
): HairSignals {
  if (semantic.hairlineVisibility !== "occluded" || signals.hairline === "occluded") {
    return signals;
  }
  return { ...signals, hairline: "occluded" };
}
