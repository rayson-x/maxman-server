import "dotenv/config";
import { createPrismaClient } from "../lib/prisma.js";

/** 只读排查：看最近产出的候选集实际落库成什么样（属性来源、可行性档位） */
const prisma = createPrismaClient();
try {
  const sets = await prisma.recommendationSet.findMany({
    orderBy: { createdAt: "desc" }, take: 8,
    include: { candidates: { orderBy: { rank: "asc" } }, plan: { include: { user: { select: { deviceSessionId: true } } } } },
  });
  for (const s of sets) {
    console.log(`\nset kind=${s.kind} status=${s.status} generation=${s.generation} createdAt=${s.createdAt.toISOString()} user=${s.plan.user.deviceSessionId}`);
    console.log("  capabilityStatus:", JSON.stringify(s.capabilityStatus));
    for (const c of s.candidates) {
      console.log(`  #${c.rank} ${c.nameZh}  [${c.verificationStatus}]  attrs=${JSON.stringify(c.estimatedAttributes)}`);
    }
  }
} finally {
  await prisma.$disconnect();
}
