import "dotenv/config";
import { createPrismaClient } from "../lib/prisma.js";
const prisma = createPrismaClient();
try {
  const bad = await prisma.recommendationSet.findMany({
    where: { status: { in: ["failed", "preparing"] } },
    orderBy: { createdAt: "desc" }, take: 6,
    select: { kind: true, status: true, failureReason: true, createdAt: true, _count: { select: { candidates: true } } },
  });
  if (bad.length === 0) console.log("无 failed/preparing 集合");
  for (const b of bad) {
    console.log(`${b.createdAt.toISOString()} ${b.kind} ${b.status} candidates=${b._count.candidates}`);
    console.log(`   reason: ${b.failureReason ?? "-"}`);
  }
} finally { await prisma.$disconnect(); }
