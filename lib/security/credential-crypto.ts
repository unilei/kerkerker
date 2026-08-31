import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/**
 * 网盘凭证静态加密（AES-256-GCM）
 *
 * 凭证（夸克 cookie 等）通过后台管理界面粘贴存储，落库前加密、
 * 读取时解密。密钥从环境变量派生：
 *   1. CREDENTIAL_ENCRYPTION_KEY（推荐，独立密钥）
 *   2. 回退 ADMIN_SESSION_SECRET / ADMIN_PASSWORD（与既有会话密钥策略一致）
 * 修改密钥后旧密文无法解密，需要重新粘贴凭证。
 */

const SECRET_SALT = "kerkerker-cloud-credential-v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class CredentialCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialCryptoError";
  }
}

function deriveKey(): Buffer {
  const secret =
    process.env.CREDENTIAL_ENCRYPTION_KEY?.trim() ||
    process.env.ADMIN_SESSION_SECRET?.trim() ||
    process.env.ADMIN_PASSWORD?.trim() ||
    "";
  if (!secret) {
    throw new CredentialCryptoError(
      "缺少 CREDENTIAL_ENCRYPTION_KEY（或 ADMIN_SESSION_SECRET），无法加解密网盘凭证"
    );
  }
  return scryptSync(secret, SECRET_SALT, 32);
}

/** 加密为 base64(iv || tag || ciphertext) */
export function encryptCredential(plaintext: string): string {
  if (!plaintext) {
    throw new CredentialCryptoError("凭证明文不能为空");
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

/** 解密 base64(iv || tag || ciphertext)；密钥不匹配或数据损坏时抛错 */
export function decryptCredential(encrypted: string): string {
  const raw = Buffer.from(encrypted, "base64");
  if (raw.length <= IV_BYTES + TAG_BYTES) {
    throw new CredentialCryptoError("凭证密文格式无效");
  }
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
      "utf8"
    );
  } catch {
    throw new CredentialCryptoError(
      "凭证解密失败：加密密钥与存储时不一致，请重新粘贴网盘凭证"
    );
  }
}

/** 凭证掩码展示：保留首尾各 6 字符，中间打码 */
export function maskCredential(plaintext: string): string {
  if (plaintext.length <= 12) return "******";
  return `${plaintext.slice(0, 6)}…${plaintext.slice(-6)}`;
}

/**
 * 解析浏览器复制的 cookie 单行串（name=value; name2=value2）。
 * 校验必须包含夸克登录态关键字段（kps/sign/__pus 等），否则视为无效。
 */
const QUARK_REQUIRED_COOKIE_KEYS = ["kps", "sign", "__pus"] as const;

export function normalizeQuarkCookie(input: string): string {
  const pairs = input
    .split(/\r?\n|;\s*/)
    .map((line) => line.trim())
    .filter((line) => line.includes("="));
  const names = new Set(
    pairs.map((pair) => pair.slice(0, pair.indexOf("=")).trim())
  );
  const missing = QUARK_REQUIRED_COOKIE_KEYS.filter((key) => !names.has(key));
  if (missing.length > 0) {
    throw new CredentialCryptoError(
      `cookie 缺少夸克登录态字段：${missing.join("、")}；请在浏览器登录 pan.quark.cn 后复制完整 cookie`
    );
  }
  return pairs.join("; ");
}
