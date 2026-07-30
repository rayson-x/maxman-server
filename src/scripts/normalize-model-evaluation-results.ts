import "dotenv/config";
import { Prisma } from "../generated/prisma/client.js";
import { createPrismaClient } from "../lib/prisma.js";
import { normalizeModelEvaluationOutput } from "../features/model-evaluation/worker.js";

const prisma = createPrismaClient();
try {
  const rows = await prisma.modelEvaluationResponse.findMany({
    where: { status: "completed", rawResponse: { not: null } },
    select: { id: true, rawResponse: true },
  });
  let restored = 0;
  for (const row of rows) {
    const structuredResponse = normalizeModelEvaluationOutput(row.rawResponse!);
    if (structuredResponse) restored += 1;
    // 归一化失败时显式写 DbNull 清空该列；直接传 null 过不了 Prisma 的 Json 入参类型。
    await prisma.modelEvaluationResponse.update({
      where: { id: row.id },
      data: { structuredResponse: structuredResponse ?? Prisma.DbNull },
    });
  }
  console.log(JSON.stringify({ scanned: rows.length, publiclyStructured: restored }));
} finally {
  await prisma.$disconnect();
}
