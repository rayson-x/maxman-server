import { generateObject } from "ai";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { createDeepSeekModel } from "../appearance-agent/providers/llm/deepseekModel.js";

const REVIEW_SCHEMA = z.object({
  classification: z.enum(["agree", "rule_gap", "rule_conflict", "rule_misapplied", "llm_hallucination"]),
  relatedRuleIds: z.array(z.string().max(100)).max(20),
  notes: z.string().min(1).max(1000),
  suggestion: z.string().min(1).max(600),
}).strict();

const FORBIDDEN_REVIEW_KEYS = /(url|prompt|transcript|photo|image|asset|raw)/i;

/** Defense in depth: comparison persistence already excludes these values, but
 * reviewer input must remain safe if an old or manually-repaired row exists. */
function sanitizeReviewerEvidence(value: unknown): unknown {
  if (typeof value === "string") {
    return /^https?:\/\//i.test(value) ? "[redacted-url]" : value;
  }
  if (Array.isArray(value)) return value.map(sanitizeReviewerEvidence);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !FORBIDDEN_REVIEW_KEYS.test(key))
      .map(([key, item]) => [key, sanitizeReviewerEvidence(item)]),
  );
}

export function reviewerPrompt(input: { domain: string; diffResult: unknown; channels: unknown[] }): string {
  return [
    "你是 BetterMeet 的内部推荐复审员。仅对已完成的高差异双源推荐做结构化分类。",
    "不得重新生成推荐，不得评价用户外貌，不得做医学诊断。不要输出照片、URL、原始 prompt 或模型原文。",
    "分类只能是 agree、rule_gap、rule_conflict、rule_misapplied、llm_hallucination。",
    `领域：${input.domain}`,
    `确定性 diff：${JSON.stringify(sanitizeReviewerEvidence(input.diffResult))}`,
    `两通道的结构化候选：${JSON.stringify(sanitizeReviewerEvidence(input.channels))}`,
    "相关规则 ID 只在输入中确实存在时填写；否则使用空数组。给出简短内部说明和后续复审建议。",
  ].join("\n");
}

/** Reviewer is asynchronous and non-authoritative: it never updates exposures or candidates. */
export function createDualSourceReviewer(prisma: PrismaClient) {
  return {
    async review(comparisonId: string) {
      const comparison = await prisma.recommendationComparisonLog.findUnique({
        where: { id: comparisonId },
        include: { channelRuns: { select: { channel: true, status: true, structuredResult: true, failureCode: true } } },
      });
      if (!comparison) return { status: "missing" as const };
      if (comparison.reviewerStatus !== "pending") return { status: "not_required" as const };
      try {
        const { object } = await generateObject({
          model: createDeepSeekModel(),
          schema: REVIEW_SCHEMA,
          prompt: reviewerPrompt({
            domain: comparison.domain,
            diffResult: comparison.diffResult,
            channels: comparison.channelRuns,
          }),
        });
        await prisma.$transaction([
          prisma.recommendationReviewerResult.upsert({
            where: { comparisonId },
            create: {
              comparisonId,
              status: "completed",
              classification: object.classification,
              relatedRuleIds: object.relatedRuleIds,
              notes: object.notes,
              suggestion: object.suggestion,
              completedAt: new Date(),
            },
            update: {
              status: "completed",
              classification: object.classification,
              relatedRuleIds: object.relatedRuleIds,
              notes: object.notes,
              suggestion: object.suggestion,
              completedAt: new Date(),
            },
          }),
          prisma.recommendationComparisonLog.update({ where: { id: comparisonId }, data: { reviewerStatus: "completed" } }),
        ]);
        return { status: "completed" as const, classification: object.classification };
      } catch (error) {
        await prisma.$transaction([
          prisma.recommendationReviewerResult.upsert({
            where: { comparisonId },
            create: { comparisonId, status: "failed", relatedRuleIds: [] },
            update: { status: "failed" },
          }),
          prisma.recommendationComparisonLog.update({ where: { id: comparisonId }, data: { reviewerStatus: "failed" } }),
        ]);
        throw error;
      }
    },
  };
}
