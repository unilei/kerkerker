import { lookup } from 'node:dns/promises';
import type { LookupAllOptions } from 'node:dns';
import { isIP } from 'node:net';

type HostResolver = (hostname: string) => Promise<string[]>;

interface SafeOutboundUrlOptions {
  resolveHostname?: HostResolver;
  /**
   * DNS 解析超时（毫秒），仅约束实际走系统解析器的路径；注入
   * resolveHostname 的调用方自行控制时序。超时按 fail-closed 处理：
   * 核实不了地址安全就不能放行出站请求。
   */
  dnsTimeoutMs?: number;
}

// getaddrinfo 无内建超时：mDNSResponder 抖动/重启时可能永久挂起
// （2026-09 实测：后台补齐任务整轮停摆 20+ 分钟）。正常解析在百毫秒级，
// 5 秒已远超慢解析的合理上界。
const DEFAULT_DNS_TIMEOUT_MS = 5_000;

export class UnsafeOutboundUrlError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'UnsafeOutboundUrlError';
    this.status = status;
  }
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  '0.0.0.0',
  '127.0.0.1',
  '::1',
  'metadata.google.internal',
]);

function normalizeHostname(hostname: string): string {
  const normalizedHostname = hostname.trim().toLowerCase().replace(/\.$/, '');

  if (normalizedHostname.startsWith('[') && normalizedHostname.endsWith(']')) {
    return normalizedHostname.slice(1, -1);
  }

  return normalizedHostname;
}

function ipv4ToNumber(address: string): number {
  return address
    .split('.')
    .map((octet) => Number.parseInt(octet, 10))
    .reduce((value, octet) => (value << 8) + octet, 0);
}

function isInIpv4Range(address: string, baseAddress: string, prefixLength: number): boolean {
  const mask = prefixLength === 0 ? 0 : (~0 << (32 - prefixLength)) >>> 0;
  const normalizedAddress = ipv4ToNumber(address) >>> 0;
  const normalizedBase = ipv4ToNumber(baseAddress) >>> 0;

  return (normalizedAddress & mask) === (normalizedBase & mask);
}

function isBlockedIpv4(address: string): boolean {
  const blockedRanges: Array<[string, number]> = [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.168.0.0', 16],
    ['224.0.0.0', 4],
  ];

  return blockedRanges.some(([baseAddress, prefixLength]) =>
    isInIpv4Range(address, baseAddress, prefixLength)
  );
}

function isBlockedIpv6(address: string): boolean {
  const normalizedAddress = address.toLowerCase().split('%')[0];

  if (normalizedAddress === '::' || normalizedAddress === '::1') {
    return true;
  }

  if (normalizedAddress.startsWith('::ffff:')) {
    const mappedAddress = parseIpv4MappedIpv6Address(normalizedAddress);
    return isIP(mappedAddress) === 4 && isBlockedIpv4(mappedAddress);
  }

  if (
    normalizedAddress.startsWith('fc') ||
    normalizedAddress.startsWith('fd') ||
    normalizedAddress.startsWith('fe8') ||
    normalizedAddress.startsWith('fe9') ||
    normalizedAddress.startsWith('fea') ||
    normalizedAddress.startsWith('feb')
  ) {
    return true;
  }

  return false;
}

function parseIpv4MappedIpv6Address(address: string): string {
  const mappedAddress = address.slice('::ffff:'.length);

  if (isIP(mappedAddress) === 4) {
    return mappedAddress;
  }

  const hextets = mappedAddress.split(':');
  if (hextets.length !== 2) {
    return mappedAddress;
  }

  const [highRaw, lowRaw] = hextets;
  if (
    !/^[0-9a-f]{1,4}$/.test(highRaw) ||
    !/^[0-9a-f]{1,4}$/.test(lowRaw)
  ) {
    return mappedAddress;
  }

  const high = Number.parseInt(highRaw, 16);
  const low = Number.parseInt(lowRaw, 16);

  return [
    high >> 8,
    high & 255,
    low >> 8,
    low & 255,
  ].join('.');
}

function isBlockedIpAddress(address: string): boolean {
  const ipVersion = isIP(address);

  if (ipVersion === 4) {
    return isBlockedIpv4(address);
  }

  if (ipVersion === 6) {
    return isBlockedIpv6(address);
  }

  return false;
}

function createDefaultHostResolver(timeoutMs: number): HostResolver {
  return async (hostname) => {
    // signal 让排队中的 getaddrinfo 在超时后尽力取消、释放线程池；
    // @types/node@20 的 LookupOptions 尚未声明 signal（运行时 Node 16.4
    // 起已支持）。取消是 best-effort，调用方的必然落地由
    // withResolutionTimeout 的竞速兜底。经带类型的变量传入以绕开
    // 对象字面量的多余属性检查，保证命中 LookupAllOptions 重载。
    const lookupOptions: LookupAllOptions & { signal: AbortSignal } = {
      all: true,
      verbatim: true,
      signal: AbortSignal.timeout(timeoutMs),
    };
    try {
      const records = await lookup(hostname, lookupOptions);
      return records.map((record) => record.address);
    } catch (error) {
      // abort 只可能来自我们自己的超时信号：归一成与竞速侧相同的
      // 错误类型，无论哪侧先落地，调用方看到的都是同一种 fail-closed
      if (
        error instanceof Error &&
        (error.name === 'AbortError' || error.name === 'TimeoutError')
      ) {
        throw new UnsafeOutboundUrlError(
          `Outbound URL host resolution timed out (${timeoutMs}ms)`
        );
      }
      throw error;
    }
  };
}

/** 定时竞速：resolver 超时未落地即抛 UnsafeOutboundUrlError（fail closed） */
function withResolutionTimeout(
  resolver: HostResolver,
  timeoutMs: number
): HostResolver {
  return async (hostname) => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new UnsafeOutboundUrlError(
              `Outbound URL host resolution timed out (${timeoutMs}ms)`
            )
          ),
        timeoutMs
      );
    });
    try {
      return await Promise.race([resolver(hostname), timeout]);
    } finally {
      clearTimeout(timer);
    }
  };
}

async function resolveHostAddresses(
  hostname: string,
  resolver: HostResolver
): Promise<string[]> {
  const normalizedHostname = normalizeHostname(hostname);
  const ipVersion = isIP(normalizedHostname);

  if (ipVersion !== 0) {
    return [normalizedHostname];
  }

  return resolver(normalizedHostname);
}

export async function assertSafeOutboundUrl(
  urlString: string,
  options: SafeOutboundUrlOptions = {}
): Promise<URL> {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(urlString);
  } catch {
    throw new UnsafeOutboundUrlError('Invalid outbound URL');
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new UnsafeOutboundUrlError('Blocked outbound URL protocol');
  }

  const hostname = normalizeHostname(parsedUrl.hostname);

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new UnsafeOutboundUrlError('Blocked outbound URL host');
  }

  const timeoutMs = options.dnsTimeoutMs ?? DEFAULT_DNS_TIMEOUT_MS;
  const resolver = withResolutionTimeout(
    options.resolveHostname ?? createDefaultHostResolver(timeoutMs),
    timeoutMs
  );
  const addresses = await resolveHostAddresses(hostname, resolver);

  if (addresses.length === 0) {
    throw new UnsafeOutboundUrlError('Outbound URL did not resolve to an address');
  }

  if (addresses.some((address) => isBlockedIpAddress(address))) {
    throw new UnsafeOutboundUrlError('Blocked outbound URL address');
  }

  return parsedUrl;
}
