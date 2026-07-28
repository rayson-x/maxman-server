export type RecommendationDomain = "style" | "hairstyle" | "wardrobe";

export type DomainCandidate = {
  /** Stable catalog or concept identity after domain canonicalization. */
  id: string;
  canonicalId: string;
  rank: number;
  nameZh: string;
  rationale: string;
  /** Only B may set this after a rule/applicability check. */
  systemSupported: boolean;
  /** Deterministic safety/feasibility conflict; such candidates are never exploratory. */
  hardConflict: boolean;
};

export type RecalledCandidate = {
  stableId: string;
  /** Byte size of the compact projection, not a full research document. */
  bytes: number;
  candidate: DomainCandidate;
};

export type CommonRecommendationInput = {
  profileSnapshotRef: string;
  /** Original authorized assets only; generated previews and target images are excluded by contract. */
  originalAssetRefs: string[];
  selectedUpstream: Record<string, string>;
  model: { provider: string; model: string; temperature: number; tokenLimit: number };
};

export type ChannelInvocation = {
  channel: "A" | "B";
  domain: RecommendationDomain;
  commonInput: CommonRecommendationInput;
  /** Deliberately absent from A so catalog knowledge cannot leak into the baseline. */
  systemContext?: { candidates: RecalledCandidate[]; rules: unknown[] };
};

export type ChannelResult = { candidates: DomainCandidate[] };

type CandidateSource = "consensus" | "system_supported" | "exploration" | "deterministic_system";

export type AssembledCandidate = DomainCandidate & { source: CandidateSource };

export type DualSourceResult = {
  main: AssembledCandidate[];
  exploration: AssembledCandidate[];
  audit: {
    retrieval: { retrievedCount: number; submittedCount: number; batchCount: number; bytes: number };
    invalidBIds: string[];
    degradation: "none" | "a_failed" | "b_failed" | "both_failed" | "catalog_unavailable";
    diff: { diffScore: number; severity: "none" | "low" | "high"; hardConflict: boolean; diffPolicyVersion: "dual-source-diff-v1" };
  };
};

export class DualSourceRecommendationEngine {
  constructor(private readonly config: {
    contextByteBudget: number;
    maxMainCandidates: number;
    /** Each channel has its own budget; one timeout never cancels or retries its peer. */
    channelTimeoutMs?: number;
  }) {
    if (!Number.isInteger(config.contextByteBudget) || config.contextByteBudget < 1) {
      throw new Error("contextByteBudget must be a positive integer");
    }
    if (!Number.isInteger(config.maxMainCandidates) || config.maxMainCandidates < 1) {
      throw new Error("maxMainCandidates must be a positive integer");
    }
  }

  async recommend(input: {
    domain: RecommendationDomain;
    commonInput: CommonRecommendationInput;
    recalled: RecalledCandidate[];
    rules: unknown[];
    deterministicFallback: DomainCandidate[];
    catalogAvailable?: boolean;
    runChannel(invocation: ChannelInvocation): Promise<ChannelResult>;
  }): Promise<DualSourceResult> {
    const catalogAvailable = input.catalogAvailable !== false;
    const recalled = [...input.recalled].sort((a, b) => a.stableId.localeCompare(b.stableId));
    const batches = catalogAvailable ? this.batches(recalled) : [];
    const retrieval = {
      retrievedCount: recalled.length,
      submittedCount: catalogAvailable ? recalled.length : 0,
      batchCount: batches.length,
      bytes: recalled.reduce((total, row) => total + row.bytes, 0),
    };

    const runA = this.withTimeout(input.runChannel({
      channel: "A", domain: input.domain, commonInput: input.commonInput,
    }), "A");
    const runB = catalogAvailable
      ? Promise.all(batches.map((candidates) => this.withTimeout(input.runChannel({
          channel: "B",
          domain: input.domain,
          commonInput: input.commonInput,
          systemContext: { candidates, rules: input.rules },
        }), "B")))
      : Promise.resolve([] as ChannelResult[]);
    const [aSettled, bSettled] = await Promise.allSettled([runA, runB]);

    const aCandidates = aSettled.status === "fulfilled" ? this.normalize(aSettled.value.candidates) : [];
    const allowedBIds = new Set(recalled.map((row) => row.stableId));
    const invalidBIds: string[] = [];
    const bCandidates = bSettled.status === "fulfilled"
      ? this.mergeBatches(bSettled.value.flatMap((result) => result.candidates), allowedBIds, invalidBIds)
      : [];
    const fallback = this.normalize(input.deterministicFallback);

    if (!catalogAvailable) {
      return this.result({
        main: [],
        exploration: this.safeExploration(aCandidates),
        retrieval,
        invalidBIds,
        degradation: "catalog_unavailable",
        aCandidates,
        bCandidates: [],
      });
    }
    if (aSettled.status === "rejected" && bSettled.status === "rejected") {
      return this.result({ main: this.withSource(fallback, "deterministic_system"), exploration: [], retrieval, invalidBIds, degradation: "both_failed", aCandidates, bCandidates });
    }
    if (aSettled.status === "rejected") {
      return this.result({ main: this.withSource(bCandidates, "system_supported"), exploration: [], retrieval, invalidBIds, degradation: "a_failed", aCandidates, bCandidates });
    }
    if (bSettled.status === "rejected") {
      return this.result({
        main: this.withSource(fallback, "deterministic_system"),
        exploration: this.safeExploration(aCandidates),
        retrieval,
        invalidBIds,
        degradation: "b_failed",
        aCandidates,
        bCandidates,
      });
    }
    // A schema-valid response that references no recalled B candidate is not a
    // usable system result. Treat it like a B failure rather than allowing an
    // empty strict intersection to erase the deterministic availability base.
    if (bCandidates.length === 0 && fallback.length > 0) {
      return this.result({
        main: this.withSource(fallback, "deterministic_system"),
        exploration: this.safeExploration(aCandidates),
        retrieval,
        invalidBIds,
        degradation: "b_failed",
        aCandidates,
        bCandidates,
      });
    }

    const aByCanonical = new Map(aCandidates.map((candidate) => [candidate.canonicalId, candidate]));
    const bByCanonical = new Map(bCandidates.map((candidate) => [candidate.canonicalId, candidate]));
    const consensus = bCandidates.filter((candidate) => aByCanonical.has(candidate.canonicalId));
    const systemSupported = bCandidates.filter((candidate) => !aByCanonical.has(candidate.canonicalId) && candidate.systemSupported);
    const main = [
      ...this.withSource(consensus, "consensus"),
      ...this.withSource(systemSupported, "system_supported"),
    ].slice(0, this.config.maxMainCandidates);
    const exploration = this.safeExploration(aCandidates.filter((candidate) => !bByCanonical.has(candidate.canonicalId)));
    return this.result({ main, exploration, retrieval, invalidBIds, degradation: "none", aCandidates, bCandidates });
  }

  private batches(rows: RecalledCandidate[]): RecalledCandidate[][] {
    if (rows.length === 0) return [];
    const batches: RecalledCandidate[][] = [];
    let current: RecalledCandidate[] = [];
    let bytes = 0;
    for (const row of rows) {
      if (current.length > 0 && bytes + row.bytes > this.config.contextByteBudget) {
        batches.push(current);
        current = [];
        bytes = 0;
      }
      current.push(row);
      bytes += row.bytes;
    }
    if (current.length > 0) batches.push(current);
    return batches;
  }

  private withTimeout<T>(promise: Promise<T>, channel: "A" | "B"): Promise<T> {
    if (!this.config.channelTimeoutMs) return promise;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`${channel}_channel_timeout`)), this.config.channelTimeoutMs);
      promise.then(
        (value) => { clearTimeout(timeout); resolve(value); },
        (error: unknown) => { clearTimeout(timeout); reject(error); },
      );
    });
  }

  private normalize(candidates: DomainCandidate[]): DomainCandidate[] {
    const byCanonical = new Map<string, DomainCandidate>();
    for (const candidate of [...candidates].sort((a, b) => a.rank - b.rank || a.canonicalId.localeCompare(b.canonicalId))) {
      if (!candidate.id || !candidate.canonicalId || byCanonical.has(candidate.canonicalId)) continue;
      byCanonical.set(candidate.canonicalId, { ...candidate });
    }
    return [...byCanonical.values()];
  }

  private mergeBatches(candidates: DomainCandidate[], allowedIds: Set<string>, invalidIds: string[]): DomainCandidate[] {
    const allowed = candidates.filter((candidate) => {
      if (allowedIds.has(candidate.canonicalId)) return true;
      invalidIds.push(candidate.canonicalId);
      return false;
    });
    invalidIds.sort();
    // Per-batch ranks are not globally comparable. Stable canonical order is
    // the merge policy, so completion order and batch size cannot change B's
    // final ordering.
    return this.normalize(
      allowed
        .sort((a, b) => a.canonicalId.localeCompare(b.canonicalId))
        .map((candidate, index) => ({ ...candidate, rank: index + 1 })),
    );
  }

  private withSource(candidates: DomainCandidate[], source: CandidateSource): AssembledCandidate[] {
    return candidates.slice(0, this.config.maxMainCandidates).map((candidate) => ({ ...candidate, source }));
  }

  private safeExploration(candidates: DomainCandidate[]): AssembledCandidate[] {
    const candidate = candidates.find((row) => !row.hardConflict);
    return candidate ? [{ ...candidate, source: "exploration" }] : [];
  }

  private result(input: {
    main: AssembledCandidate[];
    exploration: AssembledCandidate[];
    retrieval: DualSourceResult["audit"]["retrieval"];
    invalidBIds: string[];
    degradation: DualSourceResult["audit"]["degradation"];
    aCandidates: DomainCandidate[];
    bCandidates: DomainCandidate[];
  }): DualSourceResult {
    const a = new Set(input.aCandidates.map((candidate) => candidate.canonicalId));
    const b = new Set(input.bCandidates.map((candidate) => candidate.canonicalId));
    const union = new Set([...a, ...b]);
    const symmetricDifference = [...union].filter((id) => !a.has(id) || !b.has(id)).length;
    const diffScore = union.size === 0 ? 0 : symmetricDifference / union.size;
    const hardConflict = [...input.aCandidates, ...input.bCandidates].some((candidate) => candidate.hardConflict);
    return {
      main: input.main,
      exploration: input.exploration,
      audit: {
        retrieval: input.retrieval,
        invalidBIds: input.invalidBIds,
        degradation: input.degradation,
        diff: {
          diffScore,
          severity: hardConflict || diffScore >= 0.5 ? "high" : diffScore > 0 ? "low" : "none",
          hardConflict,
          diffPolicyVersion: "dual-source-diff-v1",
        },
      },
    };
  }
}
