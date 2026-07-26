import type { ImageEditResult } from "../features/appearance-agent/providers/imageEdit/types.js";
import { buildAiMetadata, embedPngMetadata } from "./aiContentLabel.js";
import { buildStorageKey, putBuffer } from "./ossUpload.js";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { env } from "../config/env.js";

export type GeneratedImageFormat = "png" | "jpeg";

export type PersistGeneratedImageParams = {
  result: ImageEditResult;
  userId: string;
  filenameBase: string;
  planId?: string;
  minBytes?: number;
  maxBytes?: number;
};

export type PersistGeneratedImageResult = {
  storageKey: string;
  format: GeneratedImageFormat;
  byteLength: number;
};

export type GeneratedImagePersistenceDeps = {
  putObject?: (storageKey: string, bytes: Buffer) => Promise<void>;
  fetchImpl?: typeof fetch;
  resolveHostname?: (hostname: string) => Promise<string[]>;
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8]);
const DEFAULT_MIN_BYTES = 10_000;
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15_000;

/**
 * 198.18.0.0/15 —— IANA 保留给网络基准测试的段（RFC 2544）。
 * fake-IP 模式的本地代理用它承载公网域名映射，所以开发机上供应商域名会解析到这里。
 * 它不是内网地址，但也不是真实可达的公网地址，因此默认仍按私网拦截。
 */
function isFakeIpProxyRange(address: string): boolean {
  const m = address.match(/^(\d+)\.(\d+)\./);
  if (!m) return false;
  return Number(m[1]) === 198 && (Number(m[2]) === 18 || Number(m[2]) === 19);
}

function isPrivateIpLiteral(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const version = isIP(host);
  if (version === 4) {
    const [a, b] = host.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (version === 6) {
    return (
      host === "::" ||
      host === "::1" ||
      host.startsWith("fc") ||
      host.startsWith("fd") ||
      host.startsWith("fe8") ||
      host.startsWith("fe9") ||
      host.startsWith("fea") ||
      host.startsWith("feb") ||
      host.startsWith("::ffff:127.") ||
      host.startsWith("::ffff:10.") ||
      host.startsWith("::ffff:192.168.")
    );
  }
  return false;
}

function assertSafeGeneratedImageUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("供应商图片 URL 无效");
  }
  if (url.protocol !== "https:") throw new Error("供应商图片 URL 必须使用 HTTPS");
  if (url.username || url.password) throw new Error("供应商图片 URL 不得包含凭证");
  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    isPrivateIpLiteral(hostname)
  ) {
    throw new Error("供应商图片 URL 未通过安全校验");
  }
  return url;
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<Buffer> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`生成图片过大（${declaredLength} > ${maxBytes} 字节）`);
  }
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error(`生成图片过大（${bytes.length} > ${maxBytes} 字节）`);
    return bytes;
  }

  const chunks: Buffer[] = [];
  let total = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("generated image exceeds configured byte limit");
      throw new Error(`生成图片过大（超过 ${maxBytes} 字节）`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

async function downloadGeneratedImage(
  imageUrl: string,
  maxBytes: number,
  fetchImpl: typeof fetch,
  resolveHostname: (hostname: string) => Promise<string[]>,
): Promise<Buffer> {
  let url = assertSafeGeneratedImageUrl(imageUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    for (let redirects = 0; redirects <= 3; redirects++) {
      const addresses = await resolveHostname(url.hostname);
      // 开发机常挂 fake-IP 代理（Clash/Surge 等），把公网域名映射进
      // 198.18.0.0/15 这个 IANA 基准测试保留段，于是所有供应商域名都被判为私网。
      //
      // 逃生阀**只放行这一个段**，不是跳过整个私网判定——
      // 127.x / 10.x / 172.16-31.x / 192.168.x / 169.254.x 等真正的 SSRF 目标
      // 在任何环境下都照旧拦截。生产环境整个逃生阀不生效。
      const allowFakeIpRange =
        !env.server.isProduction && process.env.TRUST_RESOLVED_ADDRESSES_FOR_DEV === "1";
      const blocked = addresses.filter(
        (address) => isPrivateIpLiteral(address) && !(allowFakeIpRange && isFakeIpProxyRange(address)),
      );
      if (addresses.length === 0 || blocked.length > 0) {
        throw new Error("供应商图片 URL DNS 解析未通过安全校验");
      }
      const response = await fetchImpl(url, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { Accept: "image/png,image/jpeg" },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location || redirects === 3) {
          throw new Error(`供应商图片下载重定向无效 (${response.status})`);
        }
        url = assertSafeGeneratedImageUrl(new URL(location, url).toString());
        continue;
      }
      if (!response.ok) throw new Error(`供应商图片下载失败 (${response.status})`);
      return await readBoundedResponse(response, maxBytes);
    }
    throw new Error("供应商图片下载重定向次数过多");
  } catch (error) {
    if (controller.signal.aborted) throw new Error("供应商图片下载超时");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function decodeBase64(value: string): Buffer {
  const payload = value.replace(/^data:image\/(?:png|jpeg|jpg);base64,/i, "").trim();
  if (!payload || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) {
    throw new Error("供应商返回的 base64 图片无效");
  }
  return Buffer.from(payload, "base64");
}

function detectFormat(bytes: Buffer): GeneratedImageFormat {
  if (bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return "png";
  if (bytes.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE)) return "jpeg";
  throw new Error("生成结果不是受支持的 PNG/JPEG 图片");
}

/**
 * JPEG 用 COM 注释段（0xFFFE）承载 AI 标识，插在 SOI 之后。
 * 选 COM 而非 APP11：APP11/JUMBF 是 C2PA 来源凭证的载体、需要签名链，
 * 当前目标只是「可被通用工具读出的生成标记」。
 */
function embedJpegAiMarker(bytes: Buffer, metadata: Record<string, string>): Buffer {
  const comment = Buffer.from(
    Object.entries(metadata)
      .map(([key, value]) => `${key}=${value}`)
      .join(";"),
    "utf8",
  );
  if (comment.length > 65_531) throw new Error("JPEG AI 标识过长");
  const marker = Buffer.alloc(4);
  marker[0] = 0xff;
  marker[1] = 0xfe;
  marker.writeUInt16BE(comment.length + 2, 2);
  return Buffer.concat([bytes.subarray(0, 2), marker, comment, bytes.subarray(2)]);
}

/**
 * 生成图片的唯一持久化入口：解析供应商结果、验证格式与体积、写入 AI 隐式标识，
 * 最后才把字节交给对象存储。
 */
export async function persistGeneratedImage(
  params: PersistGeneratedImageParams,
  deps: GeneratedImagePersistenceDeps = {},
): Promise<PersistGeneratedImageResult> {
  if (!params.result.imageBase64 && !params.result.imageUrl) {
    throw new Error("供应商未返回可持久化的图片内容");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(params.filenameBase)) {
    throw new Error("生成图片文件名不安全");
  }

  const minBytes = params.minBytes ?? DEFAULT_MIN_BYTES;
  const maxBytes = params.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isInteger(minBytes) || !Number.isInteger(maxBytes) || minBytes < 0 || maxBytes < minBytes) {
    throw new Error("生成图片体积边界配置无效");
  }
  const bytes = params.result.imageBase64
    ? decodeBase64(params.result.imageBase64)
    : await downloadGeneratedImage(
        params.result.imageUrl!,
        maxBytes,
        deps.fetchImpl ?? fetch,
        deps.resolveHostname ??
          (async (hostname) =>
            (await lookup(hostname, { all: true, verbatim: true })).map(
              (entry) => entry.address,
            )),
      );
  if (bytes.length < minBytes) throw new Error(`生成图片过小（${bytes.length} < ${minBytes} 字节）`);
  if (bytes.length > maxBytes) throw new Error(`生成图片过大（${bytes.length} > ${maxBytes} 字节）`);

  const format = detectFormat(bytes);
  const metadata = buildAiMetadata({ provider: params.result.provider, planId: params.planId });
  const labeled =
    format === "png"
      ? embedPngMetadata(bytes, metadata)
      : embedJpegAiMarker(bytes, metadata);
  const extension = format === "png" ? "png" : "jpg";
  const storageKey = buildStorageKey("generated", params.userId, `${params.filenameBase}.${extension}`);
  const putObject = deps.putObject ?? (async (key, body) => {
    await putBuffer(key, body);
  });
  await putObject(storageKey, labeled);

  return { storageKey, format, byteLength: labeled.length };
}
