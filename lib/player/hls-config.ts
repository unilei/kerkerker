/**
 * HLS.js 配置
 */

import { createAdFilterLoader } from "./ad-filter";

/**
 * 创建 HLS 配置（大缓冲策略）
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createHlsConfig(Hls: any): any {
  return {
    debug: false,
    enableWorker: true,
    lowLatencyMode: false,

    /* 🎯 大缓冲策略 */
    maxBufferLength: 60,
    maxMaxBufferLength: 300,
    maxBufferSize: 200 * 1000 * 1000,
    backBufferLength: 60,
    maxBufferHole: 0.5,

    /* 🚀 快速启动 */
    startLevel: 0,
    startFragPrefetch: true,

    /* 超时配置 */
    fragLoadingTimeOut: 30000,
    manifestLoadingTimeOut: 15000,
    levelLoadingTimeOut: 15000,

    /* 重试配置 */
    fragLoadingMaxRetry: 6,
    fragLoadingRetryDelay: 1000,
    fragLoadingMaxRetryTimeout: 90000,
    manifestLoadingMaxRetry: 4,
    manifestLoadingRetryDelay: 1000,
    manifestLoadingMaxRetryTimeout: 45000,
    levelLoadingMaxRetry: 6,
    levelLoadingRetryDelay: 1000,
    levelLoadingMaxRetryTimeout: 90000,

    /* ABR配置 */
    abrEwmaDefaultEstimate: 2000000,
    abrBandWidthFactor: 0.7,
    abrBandWidthUpFactor: 0.6,
    abrEwmaFastLive: 3,
    abrEwmaSlowLive: 9,

    /* 高级缓冲控制 */
    highBufferWatchdogPeriod: 3,
    nudgeOffset: 0.1,
    nudgeMaxRetry: 5,

    /* 广告过滤 */
    pLoader: createAdFilterLoader(Hls.DefaultConfig.loader),
  };
}
