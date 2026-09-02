const baseUrl = String(process.env.DEPLOY_PUBLIC_URL || "https://www.aipan.me").replace(/\/+$/, "");

let parsedBaseUrl;
try {
  parsedBaseUrl = new URL(baseUrl);
} catch {
  throw new Error("DEPLOY_PUBLIC_URL must be a valid URL");
}

if (parsedBaseUrl.protocol !== "https:" || parsedBaseUrl.username || parsedBaseUrl.password) {
  throw new Error("DEPLOY_PUBLIC_URL must be an HTTPS URL without credentials");
}

const isMobile = process.env.LHCI_FORM_FACTOR === "mobile";
const outputDir = process.env.LHCI_OUTPUT_DIR || ".lighthouseci";
// 监控当前真实存在的公开页（旧 douban 页面已移除）
const routes = [
  "/",
  "/tags",
  "/?tag=%E6%80%BB%E8%A3%81", // 301 → /tags/总裁，落在标签落地页
];
// 抽样一个真实详情页：DEPLOY_SAMPLE_DRAMA_ID 由 CI 注入（取 sitemap 首条）
if (process.env.DEPLOY_SAMPLE_DRAMA_ID) {
  routes.push(`/drama/${process.env.DEPLOY_SAMPLE_DRAMA_ID}`);
}

module.exports = {
  ci: {
    collect: {
      url: routes.map((route) => `${baseUrl}${route}`),
      numberOfRuns: 1,
      settings: {
        formFactor: isMobile ? "mobile" : "desktop",
        screenEmulation: isMobile
          ? { mobile: true, width: 412, height: 823, deviceScaleFactor: 2 }
          : { mobile: false, width: 1440, height: 900, deviceScaleFactor: 1 },
        chromeFlags: "--no-sandbox --disable-dev-shm-usage",
      },
    },
    assert: {
      assertions: {
        // The public catalog pages depend on upstream data and image services,
        // so performance can vary between GitHub-hosted audit runs. Keep a
        // tracked baseline without blocking a deployment on transient latency.
        "categories:performance": ["warn", { minScore: 0.4 }],
        "categories:accessibility": ["error", { minScore: 0.85 }],
        "categories:best-practices": ["error", { minScore: 0.85 }],
        "categories:seo": ["error", { minScore: 0.9 }],
      },
    },
    upload: {
      target: "filesystem",
      outputDir,
    },
  },
};
