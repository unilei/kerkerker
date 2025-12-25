/**
 * CORS 预检测工具
 */

import type { CorsCheckResult } from "./types";

/**
 * 检测 CORS 支持 - 区分 CORS 错误和 HTTP 错误
 */
export async function checkCorsSupport(url: string): Promise<CorsCheckResult> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);

    const response = await fetch(url, {
      method: "HEAD",
      mode: "cors",
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      return { success: true };
    }

    return { success: false, reason: "expired", code: response.status };
  } catch (error) {
    if (
      error instanceof TypeError &&
      error.message.includes("Failed to fetch")
    ) {
      return { success: false, reason: "cors" };
    }
    return { success: false, reason: "network" };
  }
}
