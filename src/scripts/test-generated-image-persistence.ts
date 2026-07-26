import { persistGeneratedImage } from "../lib/generatedImagePersistence.js";

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBytes = Buffer.from(type, "latin1");
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])) >>> 0);
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function minimalPng(): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([signature, pngChunk("IHDR", ihdr), pngChunk("IEND", Buffer.alloc(0))]);
}

let pass = 0;
let fail = 0;
function check(ok: boolean, label: string, detail = "") {
  ok ? pass++ : fail++;
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? `  ${detail}` : ""}`);
}

const writes: { storageKey: string; bytes: Buffer }[] = [];
const sourcePng = minimalPng();
const persisted = await persistGeneratedImage(
  {
    result: {
      provider: "stepfun-image-edit-2",
      imageBase64: sourcePng.toString("base64"),
      latencyMs: 12,
    },
    userId: "user-1",
    filenameBase: "hairstyle-candidate-1",
    planId: "plan-1",
    minBytes: 1,
  },
  {
    putObject: async (storageKey, bytes) => {
      writes.push({ storageKey, bytes });
    },
  },
);

check(persisted.storageKey === "generated/user-1/hairstyle-candidate-1.png", "按真实 PNG 格式选择扩展名");
check(writes.length === 1 && writes[0].storageKey === persisted.storageKey, "统一入口只持久化一次");
check(writes[0].bytes.includes(Buffer.from("AI-Generated\u0000true")), "持久化前写入 AI-Generated 隐式标识");
check(writes[0].bytes.includes(Buffer.from("AI-Provider\u0000stepfun-image-edit-2")), "隐式标识记录实际供应商");
check(writes[0].bytes.includes(Buffer.from("AI-Plan-Id\u0000plan-1")), "隐式标识记录方案");

console.log(`\n${fail === 0 ? "全部通过" : "有失败项"}：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
