import { createHash } from "node:crypto";
import {
  DualSourceRecommendationEngine,
  type CommonRecommendationInput,
  type DomainCandidate,
  type DualSourceResult,
  type RecalledCandidate,
  type RecommendationDomain,
} from "./engine.js";

export type DualSourceProviderRequest = {
  channel: "A" | "B";
  domain: RecommendationDomain;
  commonInput: CommonRecommendationInput;
  systemContext?: { candidates: RecalledCandidate[]; rules: unknown[] };
};

export type RawProviderCandidate = { nameZh: string; rationale: string; hardConflict?: boolean };

function conceptId(domain: RecommendationDomain, nameZh: string): string {
  return `concept:${domain}:${createHash("sha256").update(nameZh.trim().toLocaleLowerCase("zh-CN")).digest("hex").slice(0, 20)}`;
}

/**
 * Provider-neutral bridge. It is the only place where a model response becomes
 * an A/B channel candidate; workflows and Agents call this bridge rather than
 * invoking a channel or diff policy themselves.
 */
export function createDualSourceProviderAdapter(options: {
  contextByteBudget: number;
  maxMainCandidates: number;
  channelTimeoutMs?: number;
  invoke(request: DualSourceProviderRequest): Promise<RawProviderCandidate[]>;
}) {
  const engine = new DualSourceRecommendationEngine(options);
  return {
    async recommend(input: {
      domain: RecommendationDomain;
      commonInput: CommonRecommendationInput;
      recalled: RecalledCandidate[];
      rules: unknown[];
      deterministicFallback: DomainCandidate[];
      catalogAvailable?: boolean;
    }): Promise<DualSourceResult> {
      const allByName = new Map(input.recalled.map((row) => [row.candidate.nameZh, row]));
      return engine.recommend({
        ...input,
        runChannel: async (invocation) => {
          const raw = await options.invoke({
            channel: invocation.channel,
            domain: invocation.domain,
            commonInput: invocation.commonInput,
            ...(invocation.systemContext ? { systemContext: invocation.systemContext } : {}),
          });
          const allowedB = new Map((invocation.systemContext?.candidates ?? []).map((row) => [row.candidate.nameZh, row]));
          return {
            candidates: raw.map((candidate, index) => {
              const recalled = invocation.channel === "B"
                ? allowedB.get(candidate.nameZh)
                : allByName.get(candidate.nameZh);
              const canonicalId = recalled?.stableId ?? (invocation.channel === "B"
                ? `invalid:${candidate.nameZh}`
                : conceptId(invocation.domain, candidate.nameZh));
              return {
                id: canonicalId,
                canonicalId,
                rank: index + 1,
                nameZh: candidate.nameZh,
                rationale: candidate.rationale,
                systemSupported: invocation.channel === "B" && Boolean(recalled),
                hardConflict: candidate.hardConflict === true,
              };
            }),
          };
        },
      });
    },
  };
}
