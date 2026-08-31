import { getDatabase } from "@/lib/db";
import { COLLECTIONS } from "@/lib/constants/db";
import {
  encryptCredential,
  decryptCredential,
  maskCredential,
} from "@/lib/security/credential-crypto";

/**
 * 网盘凭证库（MongoDB cloud_credentials）
 *
 * 后台管理界面粘贴 cookie，AES-256-GCM 加密落库。
 * 每平台一条 is_default 凭证；读取方只拿解密后的明文，
 * 任何 API 响应只回传掩码。
 */

export type CloudPlatform = "quark";

export interface CloudCredentialInput {
  platform: CloudPlatform;
  /** 浏览器复制的 cookie 单行串（内部统一 normalize） */
  cookie: string;
  /** 保存时校验通过后记录的账号标识（昵称/ID），仅展示用 */
  account_label?: string;
}

export interface CloudCredentialView {
  id: string;
  platform: CloudPlatform;
  account_label?: string;
  cookie_masked: string;
  is_valid: boolean;
  last_validated_at?: string;
  created_at: string;
  updated_at: string;
}

interface CloudCredentialDoc {
  _id?: import("mongodb").ObjectId;
  platform: CloudPlatform;
  cookie_encrypted: string;
  account_label?: string;
  is_default: boolean;
  is_valid: boolean;
  last_validated_at?: string;
  created_at: string;
  updated_at: string;
}

function viewOf(doc: CloudCredentialDoc): CloudCredentialView {
  const plaintext = (() => {
    try {
      return decryptCredential(doc.cookie_encrypted);
    } catch {
      return "";
    }
  })();
  return {
    id: doc._id?.toString() || "",
    platform: doc.platform,
    ...(doc.account_label ? { account_label: doc.account_label } : {}),
    cookie_masked: plaintext ? maskCredential(plaintext) : "（解密失败，请重新粘贴）",
    is_valid: doc.is_valid,
    ...(doc.last_validated_at
      ? { last_validated_at: doc.last_validated_at }
      : {}),
    created_at: doc.created_at,
    updated_at: doc.updated_at,
  };
}

function nowIso() {
  return new Date().toISOString();
}

/** 保存（upsert）平台默认凭证；返回脱敏视图 */
export async function saveCloudCredential(
  input: CloudCredentialInput
): Promise<CloudCredentialView> {
  const db = await getDatabase();
  const collection = db.collection<CloudCredentialDoc>(
    COLLECTIONS.CLOUD_CREDENTIALS
  );
  const now = nowIso();
  const encrypted = encryptCredential(input.cookie);

  const existing = await collection.findOne({
    platform: input.platform,
    is_default: true,
  });

  const doc: Partial<CloudCredentialDoc> = {
    platform: input.platform,
    cookie_encrypted: encrypted,
    is_default: true,
    is_valid: true,
    last_validated_at: now,
    updated_at: now,
    ...(input.account_label ? { account_label: input.account_label } : {}),
  };

  if (existing) {
    await collection.updateOne({ _id: existing._id }, { $set: doc });
    const updated = await collection.findOne({ _id: existing._id });
    return viewOf(updated as CloudCredentialDoc);
  }

  const inserted = await collection.insertOne({
    ...(doc as CloudCredentialDoc),
    created_at: now,
  });
  const created = await collection.findOne({ _id: inserted.insertedId });
  return viewOf(created as CloudCredentialDoc);
}

/** 平台默认凭证视图（脱敏）；未配置返回 null */
export async function getCloudCredentialView(
  platform: CloudPlatform
): Promise<CloudCredentialView | null> {
  const db = await getDatabase();
  const doc = await db
    .collection<CloudCredentialDoc>(COLLECTIONS.CLOUD_CREDENTIALS)
    .findOne({ platform, is_default: true });
  return doc ? viewOf(doc) : null;
}

/** 平台默认凭证明文（服务端内部使用，禁止入响应） */
export async function getCloudCredentialCookie(
  platform: CloudPlatform
): Promise<string | null> {
  const db = await getDatabase();
  const doc = await db
    .collection<CloudCredentialDoc>(COLLECTIONS.CLOUD_CREDENTIALS)
    .findOne({ platform, is_default: true });
  if (!doc) return null;
  return decryptCredential(doc.cookie_encrypted);
}

/** 标记凭证失效（转存链路检测到登录态失效时调用） */
export async function markCloudCredentialInvalid(
  platform: CloudPlatform
): Promise<void> {
  const db = await getDatabase();
  await db
    .collection<CloudCredentialDoc>(COLLECTIONS.CLOUD_CREDENTIALS)
    .updateOne(
      { platform, is_default: true },
      { $set: { is_valid: false, updated_at: nowIso() } }
    );
}

/** 更新校验时间与账号标识（凭证仍有效时） */
export async function touchCloudCredential(
  platform: CloudPlatform,
  accountLabel?: string
): Promise<void> {
  const db = await getDatabase();
  await db
    .collection<CloudCredentialDoc>(COLLECTIONS.CLOUD_CREDENTIALS)
    .updateOne(
      { platform, is_default: true },
      {
        $set: {
          is_valid: true,
          last_validated_at: nowIso(),
          updated_at: nowIso(),
          ...(accountLabel ? { account_label: accountLabel } : {}),
        },
      }
    );
}
