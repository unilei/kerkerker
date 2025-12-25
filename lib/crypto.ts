/**
 * 加密/解密工具库 - PBKDF2 + AES-256-GCM
 * 
 * 用于解密从 kerkerker-config-manager 导出的加密配置
 */

import type { VodSource } from '@/types/drama';
import type { DailymotionChannelConfig } from '@/types/dailymotion-config';

const PBKDF2_ITERATIONS = 100000;

/**
 * 加密包格式
 */
export interface EncryptedPackage {
  version: string;
  algorithm: string;
  kdf: string;
  salt: string;
  iv: string;
  iterations: number;
  data: string;
  tag: string;
}

/**
 * 解密后的配置负载
 */
export interface ConfigPayload {
  type: 'vod' | 'dailymotion' | 'all';
  timestamp: number;
  expiresAt?: number;
  vodSources?: VodSource[];
  dailymotionChannels?: Omit<DailymotionChannelConfig, 'id' | 'createdAt'>[];
}

/**
 * Base64 转 Uint8Array
 */
function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * 字符串转 Uint8Array (UTF-8)
 */
function stringToUint8Array(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

/**
 * Uint8Array 转字符串 (UTF-8)
 */
function uint8ArrayToString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/**
 * PBKDF2 密钥派生
 */
async function deriveKey(
  password: string, 
  salt: Uint8Array, 
  iterations: number = PBKDF2_ITERATIONS
): Promise<CryptoKey> {
  const passwordBuffer = stringToUint8Array(password);
  
  // 导入密码作为密钥材料
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    passwordBuffer.buffer.slice(passwordBuffer.byteOffset, passwordBuffer.byteOffset + passwordBuffer.byteLength) as ArrayBuffer,
    'PBKDF2',
    false,
    ['deriveBits', 'deriveKey']
  );
  
  // 派生 AES-GCM 密钥
  return await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt.buffer.slice(salt.byteOffset, salt.byteOffset + salt.byteLength) as ArrayBuffer,
      iterations: iterations,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * 解析 Base64 加密字符串为加密包
 */
export function parseEncryptedString(base64String: string): EncryptedPackage {
  try {
    // 尝试解析为 JSON（可能是直接的加密包）
    const parsed = JSON.parse(base64String);
    if (parsed.version && parsed.algorithm) {
      return parsed as EncryptedPackage;
    }
  } catch {
    // 不是直接的 JSON，尝试 Base64 解码
  }
  
  try {
    const decoded = atob(base64String);
    return JSON.parse(decoded) as EncryptedPackage;
  } catch {
    throw new Error('无效的加密字符串格式');
  }
}

/**
 * AES-256-GCM 解密
 */
export async function decryptConfig(
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
  const saltBytes = base64ToUint8Array(salt);
  const ivBytes = base64ToUint8Array(iv);
  const dataBytes = base64ToUint8Array(data);
  const tagBytes = base64ToUint8Array(tag);
  
  // 派生密钥
  const key = await deriveKey(password, saltBytes, iterations);
  
  // 合并数据和标签（AES-GCM 需要）
  const ciphertext = new Uint8Array(dataBytes.length + tagBytes.length);
  ciphertext.set(dataBytes);
  ciphertext.set(tagBytes, dataBytes.length);
  
  // 解密
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: ivBytes.buffer.slice(ivBytes.byteOffset, ivBytes.byteOffset + ivBytes.byteLength) as ArrayBuffer },
      key,
      ciphertext.buffer.slice(ciphertext.byteOffset, ciphertext.byteOffset + ciphertext.byteLength) as ArrayBuffer
    );
    
    const payload = JSON.parse(uint8ArrayToString(new Uint8Array(plaintext)));
    
    // 验证过期时间
    if (payload.expiresAt && Date.now() > payload.expiresAt) {
      throw new Error('配置已过期');
    }
    
    return payload as ConfigPayload;
  } catch (error) {
    if (error instanceof Error && error.message.includes('过期')) {
      throw error;
    }
    throw new Error('解密失败：密码错误或数据已损坏');
  }
}

/**
 * 从 URL 获取并解密配置
 */
export async function fetchAndDecryptSubscription(
  url: string, 
  password: string
): Promise<ConfigPayload> {
  try {
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`获取配置失败: ${response.status} ${response.statusText}`);
    }
    
    const contentType = response.headers.get('content-type') || '';
    let encryptedPackage: EncryptedPackage;
    
    if (contentType.includes('application/json')) {
      // 直接是 JSON 格式的加密包
      encryptedPackage = await response.json();
    } else {
      // 可能是 Base64 编码的文本
      const text = await response.text();
      encryptedPackage = parseEncryptedString(text.trim());
    }
    
    return await decryptConfig(encryptedPackage, password);
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error('获取订阅配置失败');
  }
}

/**
 * 验证加密字符串格式是否有效
 */
export function validateEncryptedString(input: string): boolean {
  try {
    parseEncryptedString(input);
    return true;
  } catch {
    return false;
  }
}

/**
 * 判断输入是 URL 还是加密字符串
 */
export function isSubscriptionUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
