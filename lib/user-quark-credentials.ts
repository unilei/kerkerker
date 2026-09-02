import { getDatabase } from "@/lib/db";
import { COLLECTIONS } from "@/lib/constants/db";
import {
  encryptCredential,
  decryptCredential,
  CredentialCryptoError,
} from "@/lib/security/credential-crypto";

/**
 * 访客夸克凭证库（MongoDB user_quark_credentials）
 *
 * 访客扫码登录后 cookie 以 AES-256-GCM 加密落库，绑定浏览器会话 ID
 * （服务端签发的随机 token，存 HttpOnly cookie）。凭证是访客的完整
 * 账号登录态：任何 API 响应绝不回传明文/掩码，只回传「是否已登录」。
 *
 * TTL：默认 24 小时过期，过期记录延迟清理（读时惰性删除），不依赖定时任务。
 */

export const USER_QUARK_SESSION_COOKIE = "uq_session";
/** 会话/凭证有效期：24 小时 */
export const USER_QUARK_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export interface UserQuarkCredential {
  sessionId: string;
  nickname?: string;
  /** 剩余有效期（毫秒） */
  expiresInMs: number;
}

interface UserQuarkSavedItem {
  /** 转存产物根 fid（transferOnly 返回，剧名文件夹或散装剧集文件） */
  fids: string[];
  title?: string;
  saved_at: string;
}

interface UserQuarkCredentialDoc {
  _id?: import("mongodb").ObjectId;
  session_id: string;
  cookie_encrypted: string;
  /** 夸克账号唯一 ID（cookie 里的 __uid），用于清理同账号旧会话 */
  account_uid?: string;
  nickname?: string;
  /** 本会话转存过的短剧 → 转存产物 fid，试播据此定位网盘文件 */
  saved_items?: Record<string, UserQuarkSavedItem>;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

/** saved_items 容量上限：超出丢弃最旧记录，防会话文档无限膨胀 */
const USER_SAVED_ITEMS_LIMIT = 30;

function nowIso() {
  return new Date().toISOString();
}

/** 从 cookie 串提取夸克账号唯一 ID（__uid）；解析不到返回 undefined */
function extractQuarkAccountUid(cookie: string): string | undefined {
  const match = cookie.match(/(?:^|;\s*)__uid=([^;\s]+)/);
  const uid = match?.[1];
  return uid ? uid.slice(0, 128) : undefined;
}

/**
 * 保存/覆盖会话凭证（扫码成功或 Cookie 粘贴兜底成功后调用）。
 * 同一账号重复登录（重复扫码/换浏览器）会签发新会话，这里顺带清掉
 * 同 __uid 的其他会话，避免过期前的死会话积累。
 */
export async function saveUserQuarkCredential(input: {
  sessionId: string;
  cookie: string;
  nickname?: string;
}): Promise<void> {
  if (!input.sessionId || input.sessionId.length > 128) {
    throw new RangeError("会话 ID 无效");
  }
  const db = await getDatabase();
  const now = nowIso();
  const expiresAt = new Date(Date.now() + USER_QUARK_SESSION_TTL_MS).toISOString();
  const accountUid = extractQuarkAccountUid(input.cookie);
  await db
    .collection<UserQuarkCredentialDoc>(COLLECTIONS.USER_QUARK_CREDENTIALS)
    .updateOne(
      { session_id: input.sessionId },
      {
        $set: {
          cookie_encrypted: encryptCredential(input.cookie),
          ...(accountUid ? { account_uid: accountUid } : {}),
          ...(input.nickname ? { nickname: input.nickname } : {}),
          expires_at: expiresAt,
          updated_at: now,
        },
        $setOnInsert: { session_id: input.sessionId, created_at: now },
      },
      { upsert: true }
    );
  if (accountUid) {
    await db
      .collection<UserQuarkCredentialDoc>(COLLECTIONS.USER_QUARK_CREDENTIALS)
      .deleteMany({ account_uid: accountUid, session_id: { $ne: input.sessionId } });
  }
}

/** 读取会话凭证明文（服务端内部使用，禁止入响应）；过期即删并返回 null */
export async function getUserQuarkCookie(sessionId: string): Promise<string | null> {
  if (!sessionId) return null;
  const db = await getDatabase();
  const collection = db.collection<UserQuarkCredentialDoc>(
    COLLECTIONS.USER_QUARK_CREDENTIALS
  );
  const doc = await collection.findOne({ session_id: sessionId });
  if (!doc) return null;

  if (new Date(doc.expires_at).getTime() <= Date.now()) {
    await collection.deleteOne({ _id: doc._id });
    return null;
  }
  try {
    return decryptCredential(doc.cookie_encrypted);
  } catch (error) {
    if (error instanceof CredentialCryptoError) {
      // 密钥更换导致解密失败：等价于凭证丢失，清掉让访客重新扫码
      await collection.deleteOne({ _id: doc._id });
      return null;
    }
    throw error;
  }
}

/** 会话登录状态视图（不含任何凭证内容） */
export async function getUserQuarkCredential(
  sessionId: string
): Promise<UserQuarkCredential | null> {
  if (!sessionId) return null;
  const db = await getDatabase();
  const collection = db.collection<UserQuarkCredentialDoc>(
    COLLECTIONS.USER_QUARK_CREDENTIALS
  );
  const doc = await collection.findOne({ session_id: sessionId });
  if (!doc) return null;

  if (new Date(doc.expires_at).getTime() <= Date.now()) {
    await collection.deleteOne({ _id: doc._id });
    return null;
  }
  return {
    sessionId: doc.session_id,
    ...(doc.nickname ? { nickname: doc.nickname } : {}),
    expiresInMs: Math.max(0, new Date(doc.expires_at).getTime() - Date.now()),
  };
}

/** 访客主动退出登录：删除会话凭证 */
export async function deleteUserQuarkCredential(sessionId: string): Promise<void> {
  if (!sessionId) return;
  const db = await getDatabase();
  await db
    .collection<UserQuarkCredentialDoc>(COLLECTIONS.USER_QUARK_CREDENTIALS)
    .deleteOne({ session_id: sessionId });
}

/**
 * 记录一次转存产物（转存成功后调用）：dramaId → 根 fid 列表。
 * fid 列表会随后续「列出剧集文件 / 取播放直链」复用，不回传给前端。
 */
export async function rememberUserSavedItems(
  sessionId: string,
  dramaId: string,
  fids: string[],
  title?: string
): Promise<void> {
  if (!sessionId || !dramaId || fids.length === 0) return;
  const db = await getDatabase();
  const collection = db.collection<UserQuarkCredentialDoc>(
    COLLECTIONS.USER_QUARK_CREDENTIALS
  );
  const doc = await collection.findOne(
    { session_id: sessionId },
    { projection: { saved_items: 1 } }
  );
  const next: Record<string, UserQuarkSavedItem> = {
    ...(doc?.saved_items ?? {}),
    [dramaId]: {
      fids: fids.slice(0, 200),
      ...(title ? { title } : {}),
      saved_at: nowIso(),
    },
  };
  const keys = Object.keys(next);
  if (keys.length > USER_SAVED_ITEMS_LIMIT) {
    keys.sort((a, b) =>
      (next[a].saved_at || "").localeCompare(next[b].saved_at || "")
    );
    for (const key of keys.slice(0, keys.length - USER_SAVED_ITEMS_LIMIT)) {
      delete next[key];
    }
  }
  await collection.updateOne(
    { session_id: sessionId },
    { $set: { saved_items: next, updated_at: nowIso() } }
  );
}

/** 读取某剧的转存产物 fid；会话过期或没转过返回 null */
export async function getUserSavedFids(
  sessionId: string,
  dramaId: string
): Promise<string[] | null> {
  if (!sessionId || !dramaId) return null;
  const db = await getDatabase();
  const doc = await db
    .collection<UserQuarkCredentialDoc>(COLLECTIONS.USER_QUARK_CREDENTIALS)
    .findOne(
      { session_id: sessionId },
      { projection: { saved_items: 1, expires_at: 1 } }
    );
  if (!doc) return null;
  if (new Date(doc.expires_at).getTime() <= Date.now()) return null;
  return doc.saved_items?.[dramaId]?.fids ?? null;
}
