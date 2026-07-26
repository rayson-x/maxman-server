import "dotenv/config";
import { buildStorageKey, createPresignedUploadUrl, createPresignedReadUrl, isOSSConfigured, putBuffer, deleteObject } from "../lib/ossUpload.js";

/** 验证预签名 URL 真的可用（私有 Bucket 形态），而不只是能生成一个字符串。 */
if (!isOSSConfigured()) { console.log("OSS 未配置，跳过"); process.exit(0); }

const key = buildStorageKey("raw", "test-user", `presign-${Date.now()}.txt`);
const payload = Buffer.from("bettermeet presigned url test");

const up = createPresignedUploadUrl(key, { contentType: "text/plain" });
console.log(`预签名 PUT URL 已签发，有效期至 ${up.expiresAt}`);
const putRes = await fetch(up.url, { method: "PUT", body: new Uint8Array(payload), headers: { "Content-Type": "text/plain" } });
console.log(`${putRes.ok ? "✅" : "❌"} 客户端直传（PUT 预签名）  HTTP ${putRes.status}`);

const readUrl = createPresignedReadUrl(key, { expiresSeconds: 120 });
const getRes = await fetch(readUrl);
const text = await getRes.text();
console.log(`${getRes.ok && text === payload.toString() ? "✅" : "❌"} 预签名 GET 读回内容一致  HTTP ${getRes.status}`);

// 不带签名应被拒（证明 Bucket 不是公共读）
const bare = readUrl.split("?")[0];
const bareRes = await fetch(bare);
const isPrivate = bareRes.status === 403;
console.log(`${isPrivate ? "✅" : "⚠️ "} 无签名访问 HTTP ${bareRes.status}${isPrivate ? "（私有，符合生产要求）" : "（Bucket 仍是公共读，上线前必须在控制台改为私有）"}`);

await deleteObject(key);
console.log("✅ 清理完成（deleteObject 幂等）");
