import OSS from "ali-oss";
import { env, required } from "../config/env.js";

/**
 * 对象存储访问（tasks 1.5）。
 *
 * ⚠ 与本项目早期测试脚本的用法有本质区别：那时用的是**公共读 Bucket + 永久公网
 * URL**（为了让 Volcengine 能直接抓图），这在生产上不可接受——照片是人脸敏感信息，
 * 永久公开链接等于放弃访问控制。生产形态是：
 *   - 私有 Bucket
 *   - 客户端上传走**预签名 PUT URL**（直传，不经服务端中转，省带宽）
 *   - 读取走**短时预签名 GET URL**
 *
 * 供应商需要抓图时（img2img 的输入），同样给它一个短时预签名 GET URL，
 * 有效期只需覆盖单次调用（生成约 13 秒，给 10 分钟足够）。
 *
 * 前缀按类型隔离，便于分级删除与生命周期策略：
 *   raw/               原始上传照片
 *   generated/         生成的目标图
 *   derived-features/  派生特征数据
 */

const PREFIXES = {
  raw: "raw/",
  generated: "generated/",
  derivedFeatures: "derived-features/",
} as const;

export type StoragePrefix = keyof typeof PREFIXES;

/** 预签名 URL 默认有效期。够覆盖一次供应商调用（生成约 13s），又不至于长期泄露。 */
const DEFAULT_EXPIRES_SECONDS = 600;

let client: OSS | undefined;

function getClient(): OSS {
  if (!client) {
    client = new OSS({
      accessKeyId: required("ALIYUN_OSS_ACCESS_KEY_ID"),
      accessKeySecret: required("ALIYUN_OSS_ACCESS_KEY_SECRET"),
      bucket: required("ALIYUN_OSS_BUCKET"),
      region: required("ALIYUN_OSS_REGION"),
      // ali-oss 默认签发 http:// 的预签名 URL（实测：本地冒烟测试拿到的 upload-url
      // 是 http）。那意味着签名、AccessKeyId 和**用户人脸照片本体**都走明文传输。
      // 这类 URL 会经手客户端、日志、乃至 AI 供应商，必须强制 TLS。
      secure: true,
    });
  }
  return client;
}

export function isOSSConfigured(): boolean {
  const o = env.aliyunOss;
  return Boolean(o.accessKeyId && o.accessKeySecret && o.bucket && o.region);
}

export function buildStorageKey(prefix: StoragePrefix, userId: string, filename: string): string {
  return `${PREFIXES[prefix]}${userId}/${filename}`;
}

/**
 * 照片登记只能绑定服务端为当前用户签发的 raw key 形状。
 * 文件名不允许再带路径段，避免 `../`、反斜杠或嵌套前缀绕过租户边界。
 */
export function isUserRawStorageKey(storageKey: string, userId: string): boolean {
  const prefix = `${PREFIXES.raw}${userId}/`;
  if (!storageKey.startsWith(prefix)) return false;
  const filename = storageKey.slice(prefix.length);
  return (
    filename.length > 0 &&
    !filename.includes("/") &&
    !filename.includes("\\") &&
    filename !== "." &&
    filename !== ".." &&
    !/[\u0000-\u001F\u007F]/u.test(filename)
  );
}

/**
 * 签发上传用的预签名 PUT URL，客户端拿它直传对象存储。
 * 服务端在收到「上传完成」回调后才登记 UserPhoto 记录并触发内容安全审核。
 */
export function createPresignedUploadUrl(
  storageKey: string,
  opts: { expiresSeconds?: number; contentType?: string } = {},
): { url: string; storageKey: string; expiresAt: string } {
  const expires = opts.expiresSeconds ?? DEFAULT_EXPIRES_SECONDS;
  const url = getClient().signatureUrl(storageKey, {
    method: "PUT",
    expires,
    "Content-Type": opts.contentType,
  });
  return { url, storageKey, expiresAt: new Date(Date.now() + expires * 1000).toISOString() };
}

/**
 * 签发读取用的短时预签名 GET URL。
 * 既用于客户端展示，也用于给 AI 供应商抓取输入图。
 */
export function createPresignedReadUrl(storageKey: string, opts: { expiresSeconds?: number } = {}): string {
  return getClient().signatureUrl(storageKey, {
    method: "GET",
    expires: opts.expiresSeconds ?? DEFAULT_EXPIRES_SECONDS,
  });
}

/** 服务端直传（用于生成结果回存等服务端产生的内容） */
export async function putBuffer(storageKey: string, buffer: Buffer): Promise<{ storageKey: string }> {
  await getClient().put(storageKey, buffer);
  return { storageKey };
}

/** 分级删除用。不存在的 key 视为已删除，不报错——删除应当幂等。 */
export async function deleteObject(storageKey: string): Promise<void> {
  try {
    await getClient().delete(storageKey);
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === "NoSuchKey") return;
    throw err;
  }
}

/**
 * 批量删除，供异步删除队列任务使用。
 * `quiet: true` 时 OSS 只返回失败项，所以「请求数 - 失败数」才是成功数。
 */
export async function deleteObjects(storageKeys: string[]): Promise<{ requested: number; failed: string[] }> {
  if (storageKeys.length === 0) return { requested: 0, failed: [] };
  const res = await getClient().deleteMulti(storageKeys, { quiet: true });
  // ali-oss 的 deleted 元素类型在 quiet 模式下声明不精确，运行时可能是 string 或 { Key }
  const failed = ((res.deleted ?? []) as unknown[])
    .map((d) => (typeof d === "string" ? d : (d as { Key?: string })?.Key))
    .filter((k): k is string => Boolean(k));
  return { requested: storageKeys.length, failed };
}

/**
 * 兼容旧测试脚本的上传入口。生产路径应走 `createPresignedUploadUrl`（客户端直传），
 * 这个只用于服务端脚本把本地 fixture 推上去。
 */
export async function uploadBufferToOSS(storageKey: string, buffer: Buffer): Promise<string> {
  await putBuffer(storageKey, buffer);
  return createPresignedReadUrl(storageKey);
}
