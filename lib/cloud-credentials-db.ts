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

const QUARK_DRIVE_HOST = "https://drive-pc.quark.cn";
const QUARK_PUUS_REFRESH_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
/** __puus 续期最小间隔：CDN 签名 token 寿命 1-2 天，没必要频繁刷 */
const QUARK_PUUS_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1_000;

/**
 * 夸克 __puus 自动续期：__kps/__pus（登录态）寿命长，但 __puus（CDN 下载
 * 签名）1-2 天就过期——过期后转存/列目录仍正常，唯独封面下载被 CDN 412。
 * member/config 接口会对有效会话下发新 __puus（Set-Cookie），据此回写凭证。
 * 返回续期后的 cookie（无论是否续期成功，尽量返回可用 cookie）；无凭证返回 null。
 */
export async function refreshQuarkCredentialPuus(): Promise<string | null> {
  const db = await getDatabase();
  const collection = db.collection<CloudCredentialDoc>(
    COLLECTIONS.CLOUD_CREDENTIALS
  );
  const doc = await collection.findOne({ platform: "quark", is_default: true });
  if (!doc) return null;
  const cookie = decryptCredential(doc.cookie_encrypted);
  if (!cookie.includes("__kps=")) return cookie;

  // 刚续期过就直接用现有 cookie（避免每个任务都打一次 member）
  const ageMs = Date.now() - new Date(doc.updated_at).getTime();
  if (Number.isFinite(ageMs) && ageMs < QUARK_PUUS_REFRESH_INTERVAL_MS) {
    return cookie;
  }

  try {
    const response = await fetch(
      `${QUARK_DRIVE_HOST}/1/clouddrive/member?pr=ucpro&fr=pc&fetch_subscribe=true`,
      {
        signal: AbortSignal.timeout(15_000),
        headers: {
          accept: "application/json, text/plain, */*",
          referer: "https://pan.quark.cn/",
          "user-agent": QUARK_PUUS_REFRESH_UA,
          cookie,
        },
      }
    );
    const setCookies = response.headers.getSetCookie();
    let newPuus: string | null = null;
    for (const setCookie of setCookies) {
      const pair = setCookie.split(";")[0];
      if (pair.startsWith("__puus=")) newPuus = pair.slice(7);
    }
    if (response.ok && newPuus) {
      const merged = cookie
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean)
        .filter((part) => !part.startsWith("__puus="));
      merged.push(`__puus=${newPuus}`);
      const refreshed = merged.join("; ");
      // 续期即视为凭证有效（member 200 本身就是登录态校验）
      await collection.updateOne(
        { _id: doc._id },
        {
          $set: {
            cookie_encrypted: encryptCredential(refreshed),
            is_valid: true,
            updated_at: nowIso(),
          },
        }
      );
      console.log("夸克凭证 __puus 已自动续期");
      return refreshed;
    }
    // member 401 等于登录态失效，交给调用方走 markCloudCredentialInvalid
    if (response.status === 401) {
      await markCloudCredentialInvalid("quark");
    }
  } catch (error) {
    console.warn(
      "夸克 __puus 续期失败（沿用现有 cookie）:",
      error instanceof Error ? error.message : String(error)
    );
  }
  return cookie;
}
