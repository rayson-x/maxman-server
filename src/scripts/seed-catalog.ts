import "dotenv/config";
import { createPrismaClient } from "../lib/prisma.js";
import { CANDIDATE_TASK_CATALOG_SEED } from "../features/appearance-agent/data/seedCandidateTaskCatalog.js";

/**
 * 把 CandidateTaskCatalog 种子数据写入数据库（foundation tasks 10.6）。
 * 幂等：按 (domain, methodName) 去重，重复执行不会产生重复行。
 */
const prisma = createPrismaClient();
try {
  let created = 0, skipped = 0;
  for (const e of CANDIDATE_TASK_CATALOG_SEED) {
    const existing = await prisma.candidateTaskCatalog.findFirst({ where: { domain: e.domain, methodName: e.methodName } });
    if (existing) { skipped += 1; continue; }
    await prisma.candidateTaskCatalog.create({ data: {
      domain: e.domain, methodName: e.methodName, description: e.description,
      evidenceBasis: e.evidenceBasis, estTime: e.estTime, estCostRange: e.estCostRange,
      reversibility: e.reversibility, riskLevel: e.riskLevel, riskNote: e.riskNote,
      applicableStageRange: e.applicableStageRange, visualBenefitLevel: e.visualBenefitLevel,
      isRecommended: e.isRecommended, exclusionReason: e.exclusionReason,
    } });
    created += 1;
  }
  const total = await prisma.candidateTaskCatalog.count();
  const recommended = await prisma.candidateTaskCatalog.count({ where: { isRecommended: true } });
  const byDomain = await prisma.candidateTaskCatalog.groupBy({ by: ["domain"], _count: true, where: { isRecommended: true } });
  console.log(`新增 ${created} 条，跳过 ${skipped} 条（已存在）`);
  console.log(`库内共 ${total} 条，其中可推荐 ${recommended} 条、显式排除 ${total - recommended} 条`);
  console.log("按领域分布（可推荐）：");
  for (const d of byDomain.sort((a, b) => b._count - a._count)) console.log(`  ${d.domain.padEnd(16)} ${d._count} 条`);
  const excluded = await prisma.candidateTaskCatalog.findMany({ where: { isRecommended: false }, select: { methodName: true, exclusionReason: true } });
  console.log("\n显式排除（保留记录以防被重新「发明」）：");
  for (const e of excluded) console.log(`  ✗ ${e.methodName} — ${e.exclusionReason?.slice(0, 50)}...`);
} finally { await prisma.$disconnect(); }
