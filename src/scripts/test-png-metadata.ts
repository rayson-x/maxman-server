import { embedPngMetadata, readPngMetadata, buildAiMetadata } from "../lib/aiContentLabel.js";

/** 构造一个结构合法的最小 PNG：签名 + 正确的 IHDR chunk + IEND */
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const b of buf) { crc ^= b; for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, "latin1");
  const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0);
  return Buffer.concat([len, t, data, c]);
}
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ihdrData = Buffer.alloc(13);
ihdrData.writeUInt32BE(1, 0); ihdrData.writeUInt32BE(1, 4);
ihdrData[8] = 8; ihdrData[9] = 6;
const minimalPng = Buffer.concat([SIG, chunk("IHDR", ihdrData), chunk("IEND", Buffer.alloc(0))]);

let pass = 0, fail = 0;
const check = (ok: boolean, label: string, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "✅" : "❌"} ${label}${detail ? `  ${detail}` : ""}`); };

console.log(`最小 PNG: ${minimalPng.length} 字节（签名8 + IHDR25 + IEND12）`);
check(readPngMetadata(minimalPng)["AI-Generated"] === undefined, "原始 PNG 无 AI 标识（基线）");

const meta = buildAiMetadata({ provider: "volcengine", planId: "p1" });
const labeled = embedPngMetadata(minimalPng, meta);
console.log(`加标识后: ${labeled.length} 字节（+${labeled.length - minimalPng.length}）`);

const readBack = readPngMetadata(labeled);
check(readBack["AI-Generated"] === "true", "隐式标识写入并可读回", JSON.stringify(readBack["AI-Generated"]));
check(readBack["AI-Provider"] === "volcengine", "记录供应商", readBack["AI-Provider"]);
check(Boolean(readBack["AI-Generated-At"]), "记录生成时间", readBack["AI-Generated-At"]);
check(readBack.Comment?.includes("AI生成模拟效果"), "通用 Comment 键（查看器普遍可见）", readBack.Comment);
check(readBack.Software === "BetterMeet", "Software 键");
check(labeled.subarray(0, 8).equals(SIG), "PNG 签名未被破坏");
check(labeled.subarray(labeled.length - 12).includes(Buffer.from("IEND")), "IEND 仍在末尾（结构完整）");
check(embedPngMetadata(Buffer.from("not a png"), meta).toString() === "not a png", "非 PNG 原样返回");

console.log(`\n${fail === 0 ? "全部通过" : "有失败项"}：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
