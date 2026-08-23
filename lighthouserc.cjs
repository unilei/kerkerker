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
const routes = [
  "/",
  "/browse/movies",
  "/browse/tv",
  "/browse/latest",
  "/calendar",
  "/category/top250",
];

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
        "categories:performance": ["error", { minScore: 0.55 }],
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
