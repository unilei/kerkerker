import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';

import { requireAdminRequest } from '@/lib/admin-route';
import {
  assertSafeOutboundUrl,
  UnsafeOutboundUrlError,
} from '@/lib/url-security';

const PBKDF2_ITERATIONS = 100000;

interface EncryptedPackage {
  version: string;
  algorithm: string;
  kdf: string;
  salt: string;
  iv: string;
  iterations: number;
  data: string;
  tag: string;
}

interface ConfigPayload {
  type: 'vod' | 'dailymotion' | 'all';
  timestamp: number;
  expiresAt?: number;
  vodSources?: unknown[];
  dailymotionChannels?: unknown[];
}

/**
 * 服务器端解密 - 使用 Node.js crypto 模块
 * 支持 HTTP 环境（不依赖 Web Crypto API）
 */
async function decryptConfigServer(
  encryptedPackage: EncryptedPackage,
  password: string
): Promise<ConfigPayload> {
  const { salt, iv, iterations, data, tag, version, algorithm } = encryptedPackage;

  // 验证版本和算法
  if (version !== '2.0') {
    throw new Error(`不支持的加密版本: ${version}`);
  }
  if (algorithm !== 'aes-256-gcm') {
    throw new Error(`不支持的加密算法: ${algorithm}`);
  }

  // 解码 Base64
  const saltBuffer = Buffer.from(salt, 'base64');
  const ivBuffer = Buffer.from(iv, 'base64');
  const dataBuffer = Buffer.from(data, 'base64');
  const tagBuffer = Buffer.from(tag, 'base64');

  // PBKDF2 密钥派生
  const key = crypto.pbkdf2Sync(
    password,
    saltBuffer,
    iterations || PBKDF2_ITERATIONS,
    32, // 256 bits
    'sha256'
  );

  // AES-256-GCM 解密
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, ivBuffer);
    decipher.setAuthTag(tagBuffer);

    const decrypted = Buffer.concat([
      decipher.update(dataBuffer),
      decipher.final(),
    ]);

    const payload = JSON.parse(decrypted.toString('utf8')) as ConfigPayload;

    // 验证过期时间
    if (payload.expiresAt && Date.now() > payload.expiresAt) {
      throw new Error('配置已过期');
    }

    return payload;
  } catch (error) {
    if (error instanceof Error && error.message.includes('过期')) {
      throw error;
    }
    throw new Error('解密失败：密码错误或数据已损坏');
  }
}

/**
 * 解析加密字符串
 */
function parseEncryptedString(input: string): EncryptedPackage {
  try {
    // 尝试解析为 JSON
    const parsed = JSON.parse(input);
    if (parsed.version && parsed.algorithm) {
      return parsed as EncryptedPackage;
    }
  } catch {
    // 不是直接的 JSON，尝试 Base64 解码
  }

  try {
    const decoded = Buffer.from(input, 'base64').toString('utf8');
    return JSON.parse(decoded) as EncryptedPackage;
  } catch {
    throw new Error('无效的加密字符串格式');
  }
}

// POST - 解密配置
export async function POST(request: NextRequest) {
  try {
    const unauthorizedResponse = requireAdminRequest(request);
    if (unauthorizedResponse) {
      return unauthorizedResponse;
    }

    const body = await request.json();
    const { password, encryptedData, subscriptionUrl } = body;

    if (!password) {
      return NextResponse.json(
        { code: 400, message: '缺少解密密码', data: null },
        { status: 400 }
      );
    }

    let encryptedPackage: EncryptedPackage;

    if (subscriptionUrl) {
      // 从 URL 获取加密配置
      const safeSubscriptionUrl = await assertSafeOutboundUrl(subscriptionUrl);
      const response = await fetch(safeSubscriptionUrl);
      if (!response.ok) {
        throw new Error(`获取配置失败: ${response.status}`);
      }

      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        encryptedPackage = await response.json();
      } else {
        const text = await response.text();
        encryptedPackage = parseEncryptedString(text.trim());
      }
    } else if (encryptedData) {
      // 直接解析加密数据
      encryptedPackage = parseEncryptedString(encryptedData);
    } else {
      return NextResponse.json(
        { code: 400, message: '缺少加密数据或订阅 URL', data: null },
        { status: 400 }
      );
    }

    // 解密
    const payload = await decryptConfigServer(encryptedPackage, password);

    return NextResponse.json({
      code: 200,
      message: 'Success',
      data: payload,
    });
  } catch (error) {
    if (error instanceof UnsafeOutboundUrlError) {
      return NextResponse.json(
        {
          code: error.status,
          message: error.message,
          data: null,
        },
        { status: error.status }
      );
    }

    console.error('❌ 解密失败:', error);
    return NextResponse.json(
      {
        code: 500,
        message: error instanceof Error ? error.message : '解密失败',
        data: null,
      },
      { status: 500 }
    );
  }
}
