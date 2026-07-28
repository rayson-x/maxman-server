import { wardrobeCatalog, type WardrobeCatalogFormula, type WardrobeCatalogItem } from "./catalog.js";
import type {
  RecommendWardrobeRequest,
  WardrobeLook,
  WardrobeProfile,
  WardrobeRecommendationBundle,
  WardrobeSlotChoice,
} from "./types.js";

const RANKING_VERSION = "wardrobe-ranking-v0.1";

function unique<T>(rows: T[]): T[] { return [...new Set(rows)]; }

function itemScore(item: WardrobeCatalogItem, styleId: string, profile: WardrobeProfile): { score: number; reasons: string[] } {
  let score = item.styleAffinities.find((a) => a.styleId === styleId)?.strength === "core" ? 30 : 16;
  const reasons = ["属于该风格的系统衣柜候选"];
  if (profile.season && item.usage.seasons.includes(profile.season)) { score += 18; reasons.push(`适合${profile.season}季`); }
  if (profile.scene && item.usage.scenes.includes(profile.scene)) { score += 16; reasons.push(`适合${profile.scene}场景`); }
  if (profile.formalityNeed != null) score += Math.max(0, 10 - Math.abs(item.usage.formality - profile.formalityNeed) * 2);
  if (profile.budgetTier && item.usage.budgetBand.includes(profile.budgetTier)) { score += 5; reasons.push("预算带相符"); }
  if (item.usage.maintenance === "low") { score += 2; reasons.push("维护成本较低"); }
  // 软适配：永远只影响排序，不能剔除用户已选风格的单品。
  if (profile.heightCm && item.softFitSignals?.height && item.softFitSignals.height !== "all") reasons.push("已纳入身高比例的软排序");
  if (profile.bodyType && item.softFitSignals?.build && item.softFitSignals.build !== "all") reasons.push("已纳入体型的软排序");
  return { score, reasons };
}

function buildLook(formula: WardrobeCatalogFormula, styleNameZh: string, profile: WardrobeProfile, role: WardrobeLook["role"], includeSupply: boolean): WardrobeLook {
  const slots: WardrobeSlotChoice[] = formula.slots
    .filter((slot) => slot.min > 0)
    .map((slot) => {
      const choices = slot.allowedItemIds
        .map((id) => wardrobeCatalog.itemsById.get(id))
        .filter((item): item is WardrobeCatalogItem => Boolean(item))
        .map((item) => ({ item, ...itemScore(item, formula.styleId, profile) }))
        .sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id));
      const primary = choices[0];
      if (!primary) throw new Error(`Formula ${formula.id} has no resolved item for ${slot.slot}`);
      const asset = wardrobeCatalog.assetsByItemId.get(primary.item.id);
      return {
        slot: slot.slot,
        wardrobeItemId: primary.item.id,
        nameZh: primary.item.nameZh,
        replacementItemIds: choices.slice(1, 5).map((choice) => choice.item.id),
        score: primary.score,
        reasons: primary.reasons,
        asset: asset ? {
          localPath: asset.localPath,
          displayStatus: asset.displayStatus,
          virtualTryOnStatus: asset.virtualTryOn.status,
          canUseForVirtualTryOn: asset.virtualTryOn.status === "public_url_ready",
        } : null,
        ...(includeSupply ? { supply: wardrobeCatalog.supplyByItemId.get(primary.item.id) ?? [] } : {}),
      };
    });
  const score = slots.reduce((total, slot) => total + slot.score, 0) / Math.max(slots.length, 1);
  const constraintsApplied = unique([
    profile.scene ? `场景：${profile.scene}` : "场景：未提供",
    profile.season ? `季节：${profile.season}` : "季节：未提供",
    profile.heightCm || profile.weightKg || profile.bodyType ? "体型仅参与软排序，不拦截风格" : "未提供体型数据",
    profile.faceShape || profile.hairVolume || profile.hairlineSignal ? "脸型与发量信号已接收；当前衣柜条目尚无校准标签，不伪造加减分" : "未提供脸型/发量信号",
  ]);
  return {
    role, styleId: formula.styleId, styleNameZh, formulaId: formula.id, formulaNameZh: formula.nameZh, score,
    explanation: `${styleNameZh}的「${formula.nameZh}」：${formula.compositionLogic}`,
    slots, constraintsApplied,
  };
}

/** Pure, JSON-backed recommendation engine. It is safe for both workflow and Agent calls. */
export function recommendWardrobe(profile: WardrobeProfile, request: RecommendWardrobeRequest): WardrobeRecommendationBundle {
  const selectedStyleIds = unique(request.selectedStyleIds).filter((id) => wardrobeCatalog.profilesByStyleId.has(id));
  if (selectedStyleIds.length === 0) throw new Error("至少提供一个系统衣柜中存在的 selectedStyleId");
  if (selectedStyleIds.length > 3) throw new Error("一次最多选择 3 个风格，以保证每个选择都有一套结果");
  // 每个显式选择都占一个位置；调用方不能用较小的 requestedLookCount 把用户选择截掉。
  const requested = Math.max(selectedStyleIds.length, Math.max(1, Math.min(request.requestedLookCount ?? 3, 3)));
  const candidates = selectedStyleIds.flatMap((styleId) => {
    const profileRow = wardrobeCatalog.profilesByStyleId.get(styleId)!;
    return profileRow.formulaTemplates.map((formula) => buildLook(formula, profileRow.styleNameZh, profile, "alternative", request.includeSupply === true));
  }).sort((a, b) => b.score - a.score || a.formulaId.localeCompare(b.formulaId));
  // Keep at least one formula for every selected style before filling remaining positions.
  const chosen: WardrobeLook[] = [];
  for (const styleId of selectedStyleIds) {
    const hit = candidates.find((look) => look.styleId === styleId);
    if (hit) chosen.push(hit);
  }
  for (const look of candidates) if (chosen.length < requested && !chosen.some((row) => row.formulaId === look.formulaId)) chosen.push(look);
  const looks = chosen.slice(0, requested).map((look, index) => ({ ...look, role: index === 0 ? "primary" as const : "alternative" as const }));
  const explorationStyles = request.includeExplorationStyles
    ? wardrobeCatalog.profiles.filter((row) => !selectedStyleIds.includes(row.styleId)).slice(0, 2).map((row) => ({ styleId: row.styleId, styleNameZh: row.styleNameZh, reason: "可作为并列探索方向，不替代你的已选风格" }))
    : [];
  return { catalogVersion: wardrobeCatalog.version, selectedStyleIds, explorationStyles, looks, provenance: { source: "catalog_matching", rankingVersion: RANKING_VERSION, llmUsedForExplanation: false } };
}
