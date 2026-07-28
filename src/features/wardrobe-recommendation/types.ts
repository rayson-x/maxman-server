export type WardrobeProfile = {
  ageBand?: string | null;
  heightCm?: number | null;
  weightKg?: number | null;
  bodyType?: string | null;
  faceShape?: string | null;
  hairVolume?: string | null;
  hairlineSignal?: string | null;
  budgetTier?: string | null;
  scene?: string | null;
  season?: "春" | "夏" | "秋" | "冬" | null;
  formalityNeed?: number | null;
};

export type RecommendWardrobeRequest = {
  selectedStyleIds: string[];
  requestedLookCount?: number;
  includeExplorationStyles?: boolean;
  includeSupply?: boolean;
};

export type WardrobeItemAsset = {
  localPath: string;
  displayStatus: string;
  virtualTryOnStatus: string;
  canUseForVirtualTryOn: boolean;
};

export type WardrobeSlotChoice = {
  slot: string;
  wardrobeItemId: string;
  nameZh: string;
  replacementItemIds: string[];
  score: number;
  reasons: string[];
  asset: WardrobeItemAsset | null;
  supply?: Array<{ brandLineId: string; sourceUrl: string; status: string; rationale: string }>;
};

export type WardrobeLook = {
  role: "primary" | "alternative";
  styleId: string;
  styleNameZh: string;
  formulaId: string;
  formulaNameZh: string;
  score: number;
  explanation: string;
  slots: WardrobeSlotChoice[];
  constraintsApplied: string[];
};

export type WardrobeRecommendationBundle = {
  catalogVersion: string;
  selectedStyleIds: string[];
  explorationStyles: Array<{ styleId: string; styleNameZh: string; reason: string }>;
  looks: WardrobeLook[];
  provenance: {
    source: "catalog_matching";
    rankingVersion: string;
    llmUsedForExplanation: false;
  };
};
