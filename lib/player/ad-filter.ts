/**
 * M3U8 广告过滤器
 */

// 广告过滤配置
export interface AdFilterConfig {
  enabled: boolean;
  adUrlPatterns: RegExp[];
  maxAdBlockDuration: number;
  minAdBlockDuration: number;
}

export const DEFAULT_AD_FILTER_CONFIG: AdFilterConfig = {
  enabled: true,
  adUrlPatterns: [
    /[_\-\/]ad[s]?[_\-\/\.]/i,
    /advertisement/i,
    /advert/i,
    /midroll/i,
    /preroll/i,
    /postroll/i,
    /commerc/i,
    /sponsor/i,
    /promo[_\-\/\.]/i,
  ],
  maxAdBlockDuration: 120,
  minAdBlockDuration: 3,
};

/**
 * 检查URL是否匹配广告模式
 */
function isAdUrl(url: string, config: AdFilterConfig): boolean {
  return config.adUrlPatterns.some((pattern) => pattern.test(url));
}

/**
 * 检查discontinuity区块是否应该被过滤
 */
function shouldFilterDiscontinuityBlock(
  lines: string[],
  duration: number,
  config: AdFilterConfig
): boolean {
  if (
    duration < config.minAdBlockDuration ||
    duration > config.maxAdBlockDuration
  ) {
    return false;
  }

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine.startsWith("#") && trimmedLine.length > 0) {
      if (isAdUrl(trimmedLine, config)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * 过滤M3U8中的广告片段
 */
export function filterAdsFromM3u8(
  content: string,
  config: AdFilterConfig = DEFAULT_AD_FILTER_CONFIG
): string {
  if (!config.enabled) return content;

  const lines = content.split("\n");
  const result: string[] = [];

  let inDiscontinuityBlock = false;
  let discontinuityBlockLines: string[] = [];
  let discontinuityBlockDuration = 0;
  let filteredAdCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmedLine = line.trim();

    if (trimmedLine === "#EXT-X-DISCONTINUITY") {
      if (inDiscontinuityBlock) {
        if (
          shouldFilterDiscontinuityBlock(
            discontinuityBlockLines,
            discontinuityBlockDuration,
            config
          )
        ) {
          console.log(
            `🚫 过滤广告区块: ${discontinuityBlockDuration.toFixed(1)}秒`
          );
          filteredAdCount++;
        } else {
          result.push(...discontinuityBlockLines);
        }
        discontinuityBlockLines = [line];
        discontinuityBlockDuration = 0;
      } else {
        inDiscontinuityBlock = true;
        discontinuityBlockLines = [line];
        discontinuityBlockDuration = 0;
      }
      continue;
    }

    if (inDiscontinuityBlock) {
      discontinuityBlockLines.push(line);

      if (trimmedLine.startsWith("#EXTINF:")) {
        const match = trimmedLine.match(/#EXTINF:([0-9.]+)/);
        if (match) {
          discontinuityBlockDuration += parseFloat(match[1]);
        }
      }

      if (i === lines.length - 1) {
        if (
          shouldFilterDiscontinuityBlock(
            discontinuityBlockLines,
            discontinuityBlockDuration,
            config
          )
        ) {
          console.log(
            `🚫 过滤广告区块(末尾): ${discontinuityBlockDuration.toFixed(1)}秒`
          );
          filteredAdCount++;
        } else {
          result.push(...discontinuityBlockLines);
        }
        inDiscontinuityBlock = false;
      }
    } else {
      if (!trimmedLine.startsWith("#") && trimmedLine.length > 0) {
        if (isAdUrl(trimmedLine, config)) {
          if (
            result.length > 0 &&
            result[result.length - 1].trim().startsWith("#EXTINF:")
          ) {
            result.pop();
          }
          console.log(`🚫 过滤广告URL: ${trimmedLine.substring(0, 50)}...`);
          filteredAdCount++;
          continue;
        }
      }
      result.push(line);
    }
  }

  if (filteredAdCount > 0) {
    console.log(`✅ 广告过滤完成: 共过滤 ${filteredAdCount} 个广告片段/区块`);
  }

  return result.join("\n");
}

/**
 * 创建广告过滤 Loader
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export function createAdFilterLoader(DefaultLoader: any) {
  return class AdFilterLoader extends DefaultLoader {
    constructor(config: any) {
      super(config);
    }

    load(context: any, config: any, callbacks: any) {
      const originalOnSuccess = callbacks.onSuccess;

      callbacks.onSuccess = (
        response: any,
        stats: any,
        context: any,
        networkDetails: any
      ) => {
        if (
          typeof response.data === "string" &&
          (context.url?.includes(".m3u8") ||
            response.data.includes("#EXTM3U"))
        ) {
          console.log("🚫 开始过滤广告...");
          response.data = filterAdsFromM3u8(
            response.data,
            DEFAULT_AD_FILTER_CONFIG
          );
        }

        if (originalOnSuccess) {
          originalOnSuccess(response, stats, context, networkDetails);
        }
      };

      super.load(context, config, callbacks);
    }
  };
}
