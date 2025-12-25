/**
 * 播放器相关类型定义
 */

// 错误类型定义
export type ErrorType =
  | "network"
  | "media"
  | "key"
  | "manifest"
  | "fragment"
  | "unknown";

export interface PlayerError {
  type: ErrorType;
  message: string;
  canRetry: boolean;
}

// HLS错误数据接口
export interface HlsErrorData {
  type?: string;
  details?: string;
  fatal?: boolean;
  reason?: string;
  response?: {
    code?: number;
    text?: string;
  };
  frag?: unknown;
  level?: number;
}

// CORS 预检测结果类型
export type CorsCheckResult =
  | { success: true }
  | { success: false; reason: "cors" }
  | { success: false; reason: "expired"; code: number }
  | { success: false; reason: "network" };
