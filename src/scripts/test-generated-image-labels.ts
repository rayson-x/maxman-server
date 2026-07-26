import "dotenv/config";
import { createPrismaClient } from "../lib/prisma.js";
import { createPresignedReadUrl } from "../lib/ossUpload.js";
import { readPngMetadata } from "../lib/aiContentLabel.js";

/**
 * 验证 AI 生成内容标识（tasks 9.12）。
 *
 * **零额外费用**：读的是冒烟测试已经生成并落库的真实图片，不再触发生成调用。
 *
 * 单张图片得到的是「显式一层 + 格式对应的隐式一层」——
 * API 响应里的 `disclosure` 文案，加上该格式对应的那一种嵌入标识
 * （PNG 写 tEXt，JPEG 写 APP11）。同一张图不会同时具备两种格式的标识，
 * 所以「三层标识」的说法是不准确的。
 */

const prisma = createPrismaClient();
let pass = 0, fail = 0;
const check = (ok: boolean, label: string, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? `  ${detail}` : ""}`);
};

try {
  const assets = await prisma.generatedAsset.findMany({
    orderBy: { createdAt: "desc" },
    take: 5,
  });

  if (assets.length === 0) {
    console.log("⚠ 没有可检的生成资产。先跑一次 scripts/smoke-http-flow.sh 产出真实图片。");
    process.exitCode = 1;
  } else {
    console.log(`检查最近 ${assets.length} 条生成资产（读回 OSS，不产生生成费用）\n`);

    // ① 显式标识：台账里带 disclosure，API 响应据此展示
    check(
      assets.every((a) => a.disclosure.length > 0),
      "**每条资产都带显式标识文案**",
      assets[0]!.disclosure,
    );
    check(
      assets.every((a) => /AI|生成|模拟/.test(a.disclosure)),
      "文案表明是 AI 生成的模拟效果",
    );

    // ② 隐式标识：读回图片字节，检查格式对应的嵌入
    let pngChecked = 0;
    let jpegChecked = 0;
    for (const a of assets) {
      const url = createPresignedReadUrl(a.storageKey, { expiresSeconds: 300 });
      const res = await fetch(url);
      if (!res.ok) {
        check(false, `读回 ${a.storageKey.slice(-28)} 失败`, `HTTP ${res.status}`);
        continue;
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      const isPng = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      const isJpeg = bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]));

      if (isPng) {
        const meta = readPngMetadata(bytes);
        const keys = Object.keys(meta);
        check(keys.length > 0, `PNG 隐式标识存在：${a.storageKey.slice(-24)}`, keys.join(","));
        check(
          Object.values(meta).some((v) => /AI|生成|simulat/i.test(v)),
          "PNG tEXt 内容表明是 AI 生成",
          JSON.stringify(meta).slice(0, 80),
        );
        pngChecked += 1;
      } else if (isJpeg) {
        // JPEG 用 COM 注释段（0xFFFE）承载标识，插在 SOI 之后。
        // 不是 APP11——那是 C2PA 来源凭证的载体，需要签名链，当前不做。
        const hasCom = bytes.subarray(2, 4).equals(Buffer.from([0xff, 0xfe]));
        check(hasCom, `JPEG COM 隐式标识存在：${a.storageKey.slice(-24)}`);
        if (hasCom) {
          const len = bytes.readUInt16BE(4);
          const text = bytes.subarray(6, 4 + len).toString("utf8");
          check(/ai|generated|simulat/i.test(text), "COM 内容表明是 AI 生成", text.slice(0, 60));
        }
        jpegChecked += 1;
      } else {
        check(false, `未识别的图片格式：${a.storageKey.slice(-24)}`);
      }
    }

    check(pngChecked + jpegChecked > 0, "至少检到一张真实生成图", `PNG ${pngChecked} / JPEG ${jpegChecked}`);
    console.log(
      `\n口径说明：单张图片 = 显式一层（disclosure）+ 格式对应的隐式一层` +
        `（本批 PNG ${pngChecked} 张、JPEG ${jpegChecked} 张），不会同时具备两种格式的标识。`,
    );
  }

  console.log(`\n${fail === 0 ? "全部通过" : "有失败项"}：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
