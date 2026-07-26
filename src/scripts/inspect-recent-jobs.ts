import "dotenv/config";
import { createPrismaClient } from "../lib/prisma.js";

/** 只读排查：最近的 job 与付费调用，用于确认有没有意外的重复调用 */
const prisma = createPrismaClient();
try {
  const jobs = await prisma.analysisJob.findMany({
    orderBy: { createdAt: "desc" }, take: 8,
    select: { id: true, jobType: true, status: true, createdAt: true, updatedAt: true, errorReason: true },
  });
  for (const j of jobs) {
    console.log(`${j.createdAt.toISOString()}  ${j.jobType.padEnd(26)} ${j.status.padEnd(10)}  ${j.errorReason?.slice(0, 50) ?? ""}`);
  }
  console.log("\n最近付费调用台账：");
  const logs = await prisma.providerCallLog.findMany({
    orderBy: { createdAt: "desc" }, take: 10,
    select: { createdAt: true, provider: true, reqKey: true, purpose: true, status: true },
  });
  for (const l of logs) {
    console.log(`${l.createdAt.toISOString()}  ${l.provider}/${l.reqKey ?? "-"}  ${l.purpose ?? "-"}  ${l.status}`);
  }
} finally {
  await prisma.$disconnect();
}
