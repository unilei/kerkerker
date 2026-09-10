/**
 * 凭证加密单元测试（无外部网络）
 *
 * 运行：npx tsx tests/short-drama.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  encryptCredential,
  decryptCredential,
  maskCredential,
  normalizeQuarkCookie,
} from "@/lib/security/credential-crypto";
import { CredentialCryptoError } from "@/lib/security/credential-crypto";

test("credential-crypto：加解密往返 + 密钥隔离 + 掩码", () => {
  process.env.CREDENTIAL_ENCRYPTION_KEY = "test-key-short-drama";
  const plaintext = "kps=abc123; sign=def456; __pus=xyz789; __puus=tuv000";
  const encrypted = encryptCredential(plaintext);
  assert.notEqual(encrypted, plaintext);
  assert.equal(decryptCredential(encrypted), plaintext);

  // 不同密钥解密必须失败
  process.env.CREDENTIAL_ENCRYPTION_KEY = "another-key";
  assert.throws(() => decryptCredential(encrypted), CredentialCryptoError);

  process.env.CREDENTIAL_ENCRYPTION_KEY = "test-key-short-drama";
  assert.equal(maskCredential(plaintext), "kps=ab…tuv000");
  assert.equal(maskCredential("short"), "******");
});

test("normalizeQuarkCookie：无登录态字段报错，新旧 schema 均规整通过", () => {
  assert.throws(
    () => normalizeQuarkCookie("foo=bar; baz=qux"),
    CredentialCryptoError
  );
  // 旧 schema（kps/sign）
  assert.equal(
    normalizeQuarkCookie("kps=abc; __pus=def;\nsign=ghi; extra=1"),
    "kps=abc; __pus=def; sign=ghi; extra=1"
  );
  // 2026-09 实测新 schema（__kps/__kp/__pus/__puus，无 kps/sign）
  assert.equal(
    normalizeQuarkCookie("__uid=u1; __kps=k1; __pus=p1; __kp=kp1; __puus=pu1"),
    "__uid=u1; __kps=k1; __pus=p1; __kp=kp1; __puus=pu1"
  );
});

console.log("short-drama tests done");
