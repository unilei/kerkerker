import {
  CLOUD_DRIVE_FEATURES,
  PLUGIN_CAPABILITIES,
  PLUGIN_CONTRACT_VERSION,
  type PluginManifest,
} from "@/lib/plugins/types";
import {
  PluginError,
  type PluginErrorCode,
  type PluginValidationIssue,
} from "@/lib/plugins/errors";

const PLUGIN_ID_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)*$/;
const FULL_SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const CONTRACT_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/;
const LOCALE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const CONFIG_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const SECRET_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const STORAGE_PERMISSIONS = new Set([
  "none",
  "ephemeral",
  "namespaced",
  "persistent",
]);
const CONFIG_FIELD_TYPES = new Set([
  "string",
  "number",
  "boolean",
  "url",
  "secret",
  "select",
]);
const CAPABILITY_SET = new Set<string>(PLUGIN_CAPABILITIES);
const CLOUD_DRIVE_FEATURE_SET = new Set<string>(CLOUD_DRIVE_FEATURES);

type IssueCode = PluginErrorCode;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addIssue(
  issues: PluginValidationIssue[],
  code: IssueCode,
  path: string,
  message: string
): void {
  issues.push({ code, path, message });
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFullSemver(value: unknown): value is string {
  return typeof value === "string" && FULL_SEMVER_PATTERN.test(value);
}

function isContractVersion(value: unknown): value is string {
  return typeof value === "string" && CONTRACT_VERSION_PATTERN.test(value);
}

function validateRuntime(
  runtime: unknown,
  issues: PluginValidationIssue[]
): void {
  if (!isRecord(runtime)) {
    addIssue(issues, "INVALID_RUNTIME", "runtime", "runtime must be an object");
    return;
  }

  const mode = runtime.mode;
  const entry = runtime.entry;
  if (mode !== "built-in" && mode !== "package" && mode !== "remote") {
    addIssue(
      issues,
      "INVALID_RUNTIME",
      "runtime.mode",
      "runtime.mode must be built-in, package, or remote"
    );
  }
  if (!nonEmptyString(entry) || entry.includes("\0")) {
    addIssue(
      issues,
      "INVALID_RUNTIME",
      "runtime.entry",
      "runtime.entry must be a non-empty safe entry"
    );
    return;
  }

  if (mode === "remote") {
    try {
      const url = new URL(entry);
      if (url.protocol !== "https:") {
        addIssue(
          issues,
          "INVALID_RUNTIME",
          "runtime.entry",
          "remote runtime entries must use HTTPS"
        );
      }
      if (url.username || url.password || url.hostname.includes("*")) {
        addIssue(
          issues,
          "DANGEROUS_NETWORK_HOST",
          "runtime.entry",
          "remote runtime entries cannot contain credentials or wildcard hosts"
        );
      }
    } catch {
      addIssue(
        issues,
        "INVALID_RUNTIME",
        "runtime.entry",
        "remote runtime entry must be a valid URL"
      );
    }
  } else if (/^[a-z][a-z\d+.-]*:\/\//i.test(entry)) {
    addIssue(
      issues,
      "INVALID_RUNTIME",
      "runtime.entry",
      "local runtime entries must be module specifiers, not URLs"
    );
  }
}

function validateCapabilities(
  capabilities: unknown,
  issues: PluginValidationIssue[]
): void {
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    addIssue(
      issues,
      "INVALID_MANIFEST",
      "capabilities",
      "at least one capability declaration is required"
    );
    return;
  }

  const seen = new Set<string>();
  capabilities.forEach((rawCapability, index) => {
    const path = `capabilities[${index}]`;
    if (!isRecord(rawCapability)) {
      addIssue(
        issues,
        "UNKNOWN_CAPABILITY",
        path,
        "capability must be an object with id and version"
      );
      return;
    }

    const id = rawCapability.id;
    if (typeof id !== "string" || !CAPABILITY_SET.has(id)) {
      addIssue(
        issues,
        "UNKNOWN_CAPABILITY",
        `${path}.id`,
        `unknown capability: ${String(id)}`
      );
      return;
    }
    if (seen.has(id)) {
      addIssue(
        issues,
        "DUPLICATE_CAPABILITY",
        `${path}.id`,
        `capability is declared more than once: ${id}`
      );
    }
    seen.add(id);

    if (!isFullSemver(rawCapability.version)) {
      addIssue(
        issues,
        "INVALID_CAPABILITY_VERSION",
        `${path}.version`,
        "capability version must be a complete SemVer"
      );
    }

    if (id === "resource.cloud-drive") {
      const features = rawCapability.features;
      if (!Array.isArray(features) || features.length === 0) {
        addIssue(
          issues,
          "INVALID_CLOUD_DRIVE_FEATURE",
          `${path}.features`,
          "cloud-drive must declare at least one of search, incremental, availability"
        );
        return;
      }
      const seenFeatures = new Set<string>();
      features.forEach((feature, featureIndex) => {
        if (typeof feature !== "string" || !CLOUD_DRIVE_FEATURE_SET.has(feature)) {
          addIssue(
            issues,
            "INVALID_CLOUD_DRIVE_FEATURE",
            `${path}.features[${featureIndex}]`,
            `unknown cloud-drive feature: ${String(feature)}`
          );
        } else if (seenFeatures.has(feature)) {
          addIssue(
            issues,
            "INVALID_CLOUD_DRIVE_FEATURE",
            `${path}.features[${featureIndex}]`,
            `cloud-drive feature is duplicated: ${feature}`
          );
        }
        if (typeof feature === "string") seenFeatures.add(feature);
      });
    }
  });
}

function validateLocales(locales: unknown, issues: PluginValidationIssue[]): void {
  if (!Array.isArray(locales) || locales.length === 0) {
    addIssue(
      issues,
      "INVALID_MANIFEST",
      "locales",
      "at least one BCP 47 locale is required"
    );
    return;
  }
  const seen = new Set<string>();
  locales.forEach((locale, index) => {
    if (typeof locale !== "string" || !LOCALE_PATTERN.test(locale)) {
      addIssue(
        issues,
        "INVALID_MANIFEST",
        `locales[${index}]`,
        "locale must be a valid BCP 47-style tag"
      );
    } else if (seen.has(locale.toLowerCase())) {
      addIssue(
        issues,
        "INVALID_MANIFEST",
        `locales[${index}]`,
        `locale is duplicated: ${locale}`
      );
    }
    if (typeof locale === "string") seen.add(locale.toLowerCase());
  });
}

function validateConfig(config: unknown, issues: PluginValidationIssue[]): void {
  if (!isRecord(config)) {
    addIssue(issues, "INVALID_MANIFEST", "config", "config schema is required");
    return;
  }
  if (!isContractVersion(config.version)) {
    addIssue(
      issues,
      "INVALID_SEMVER",
      "config.version",
      "config schema version must be major.minor or major.minor.patch"
    );
  }
  if (!Array.isArray(config.fields)) {
    addIssue(issues, "INVALID_MANIFEST", "config.fields", "config.fields must be an array");
    return;
  }
  const seen = new Set<string>();
  config.fields.forEach((rawField, index) => {
    const path = `config.fields[${index}]`;
    if (!isRecord(rawField)) {
      addIssue(issues, "INVALID_MANIFEST", path, "config field must be an object");
      return;
    }
    const key = rawField.key;
    if (typeof key !== "string" || !CONFIG_KEY_PATTERN.test(key)) {
      addIssue(issues, "INVALID_MANIFEST", `${path}.key`, "invalid config field key");
    } else if (seen.has(key)) {
      addIssue(issues, "DUPLICATE_CONFIG_FIELD", `${path}.key`, `duplicate config key: ${key}`);
    }
    if (typeof key === "string") seen.add(key);

    if (typeof rawField.type !== "string" || !CONFIG_FIELD_TYPES.has(rawField.type)) {
      addIssue(issues, "INVALID_MANIFEST", `${path}.type`, "invalid config field type");
    }
    if (rawField.type === "secret" && rawField.secret !== true) {
      addIssue(issues, "INVALID_PERMISSION", `${path}.secret`, "secret fields must set secret=true");
    }
    if (rawField.secret === true && rawField.type !== "secret") {
      addIssue(issues, "INVALID_PERMISSION", `${path}.secret`, "only secret fields may set secret=true");
    }
    if (rawField.options !== undefined) {
      if (
        !Array.isArray(rawField.options) ||
        rawField.options.some((option) => !nonEmptyString(option))
      ) {
        addIssue(issues, "INVALID_MANIFEST", `${path}.options`, "options must be non-empty strings");
      }
    }
    if (rawField.type === "select" && (!Array.isArray(rawField.options) || rawField.options.length === 0)) {
      addIssue(issues, "INVALID_MANIFEST", `${path}.options`, "select fields require options");
    }
  });
}

function validateCompliance(
  compliance: unknown,
  issues: PluginValidationIssue[]
): void {
  if (!isRecord(compliance)) {
    addIssue(
      issues,
      "MISSING_COMPLIANCE",
      "compliance",
      "compliance declaration is required"
    );
    return;
  }
  if (!nonEmptyString(compliance.legalBasis)) {
    addIssue(
      issues,
      "MISSING_COMPLIANCE",
      "compliance.legalBasis",
      "legalBasis is required"
    );
  }
  if (!nonEmptyString(compliance.contentScope) &&
      !(Array.isArray(compliance.contentScope) &&
        compliance.contentScope.length > 0 &&
        compliance.contentScope.every(nonEmptyString))) {
    addIssue(
      issues,
      "MISSING_COMPLIANCE",
      "compliance.contentScope",
      "contentScope is required"
    );
  }
  if (
    !Array.isArray(compliance.regions) ||
    compliance.regions.length === 0 ||
    compliance.regions.some((region) => typeof region !== "string" || !/^(?:[A-Z]{2}|GLOBAL)$/.test(region))
  ) {
    addIssue(
      issues,
      "MISSING_COMPLIANCE",
      "compliance.regions",
      "regions must contain ISO alpha-2 codes or GLOBAL"
    );
  }
  if (!nonEmptyString(compliance.dataClassification)) {
    addIssue(
      issues,
      "MISSING_COMPLIANCE",
      "compliance.dataClassification",
      "dataClassification is required"
    );
  }
  if (compliance.termsUrl !== undefined) {
    try {
      const termsUrl = new URL(String(compliance.termsUrl));
      if (termsUrl.protocol !== "https:" || !termsUrl.hostname) throw new Error("unsafe URL");
    } catch {
      addIssue(
        issues,
        "INVALID_COMPLIANCE",
        "compliance.termsUrl",
        "termsUrl must be an HTTPS URL"
      );
    }
  }
  for (const field of ["owner", "authorizationRef"] as const) {
    if (compliance[field] !== undefined && !nonEmptyString(compliance[field])) {
      addIssue(issues, "INVALID_COMPLIANCE", `compliance.${field}`, `${field} must be a non-empty string`);
    }
  }
  if (compliance.dataPurpose !== undefined &&
      !nonEmptyString(compliance.dataPurpose) &&
      !(Array.isArray(compliance.dataPurpose) && compliance.dataPurpose.length > 0 && compliance.dataPurpose.every(nonEmptyString))) {
    addIssue(issues, "INVALID_COMPLIANCE", "compliance.dataPurpose", "dataPurpose must be a non-empty string or list");
  }
  if (compliance.retentionDays !== undefined &&
      (typeof compliance.retentionDays !== "number" ||
        !Number.isSafeInteger(compliance.retentionDays) ||
        compliance.retentionDays < 1 || compliance.retentionDays > 3650)) {
    addIssue(issues, "INVALID_COMPLIANCE", "compliance.retentionDays", "retentionDays must be an integer from 1 to 3650");
  }
  for (const field of ["correctionContact", "takedownContact"] as const) {
    const contact = compliance[field];
    if (contact === undefined) continue;
    if (typeof contact === "string") {
      if (!nonEmptyString(contact)) addIssue(issues, "INVALID_COMPLIANCE", `compliance.${field}`, `${field} must not be empty`);
      continue;
    }
    if (!isRecord(contact) || !Object.values(contact).some(nonEmptyString)) {
      addIssue(issues, "INVALID_COMPLIANCE", `compliance.${field}`, `${field} must contain contact information`);
    }
  }
}

function validateNetworkHost(host: unknown, path: string, issues: PluginValidationIssue[]): void {
  if (!nonEmptyString(host)) {
    addIssue(issues, "INVALID_NETWORK_HOST", path, "network host must be a non-empty string");
    return;
  }
  const value = host.trim();
  if (/[?*]/.test(value) || value.startsWith(".") || value.includes("..")) {
    addIssue(
      issues,
      "DANGEROUS_NETWORK_HOST",
      path,
      "network hosts must be exact values; wildcard patterns are forbidden"
    );
    return;
  }

  let hostname = value;
  if (value.includes("://")) {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("protocol");
      if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
        throw new Error("not an origin");
      }
      hostname = url.hostname;
    } catch {
      addIssue(issues, "INVALID_NETWORK_HOST", path, "network host must be an exact host or origin");
      return;
    }
  }
  if (
    !hostname ||
    /[\s\\/]/.test(hostname) ||
    hostname.includes("*") ||
    !/^\[?[A-Za-z0-9:.-]+\]?$/.test(hostname)
  ) {
    addIssue(issues, "INVALID_NETWORK_HOST", path, "network host contains invalid characters");
  }
}

function validatePermissions(
  permissions: unknown,
  issues: PluginValidationIssue[]
): void {
  if (!isRecord(permissions)) {
    addIssue(issues, "INVALID_PERMISSION", "permissions", "permissions are required");
    return;
  }
  if (!Array.isArray(permissions.networkHosts)) {
    addIssue(issues, "INVALID_PERMISSION", "permissions.networkHosts", "networkHosts must be an array");
  } else {
    const seen = new Set<string>();
    permissions.networkHosts.forEach((host, index) => {
      validateNetworkHost(host, `permissions.networkHosts[${index}]`, issues);
      if (typeof host === "string") {
        const normalized = host.trim().toLowerCase();
        if (seen.has(normalized)) {
          addIssue(issues, "INVALID_NETWORK_HOST", `permissions.networkHosts[${index}]`, "duplicate network host");
        }
        seen.add(normalized);
      }
    });
  }
  if (!Array.isArray(permissions.secrets)) {
    addIssue(issues, "INVALID_PERMISSION", "permissions.secrets", "secrets must be an array");
  } else {
    const seen = new Set<string>();
    permissions.secrets.forEach((secret, index) => {
      if (typeof secret !== "string" || !SECRET_NAME_PATTERN.test(secret)) {
        addIssue(issues, "INVALID_PERMISSION", `permissions.secrets[${index}]`, "invalid secret name");
      } else if (seen.has(secret)) {
        addIssue(issues, "INVALID_PERMISSION", `permissions.secrets[${index}]`, "duplicate secret name");
      }
      if (typeof secret === "string") seen.add(secret);
    });
  }
  if (typeof permissions.storage !== "string" || !STORAGE_PERMISSIONS.has(permissions.storage)) {
    addIssue(
      issues,
      "INVALID_PERMISSION",
      "permissions.storage",
      "storage must be none, ephemeral, namespaced, or persistent"
    );
  }
}

/** Returns all actionable manifest issues without throwing or performing I/O. */
export function getPluginManifestIssues(value: unknown): readonly PluginValidationIssue[] {
  const issues: PluginValidationIssue[] = [];
  if (!isRecord(value)) {
    return [
      {
        code: "INVALID_MANIFEST",
        path: "manifest",
        message: "manifest must be a non-null object",
      },
    ];
  }

  if (!nonEmptyString(value.id) || value.id.length < 3 || value.id.length > 100 || !PLUGIN_ID_PATTERN.test(value.id)) {
    addIssue(
      issues,
      "INVALID_PLUGIN_ID",
      "id",
      "id must be 3-100 chars of lowercase letters, digits, dots, or hyphens"
    );
  }
  if (!nonEmptyString(value.name)) addIssue(issues, "INVALID_MANIFEST", "name", "name is required");
  if (!isFullSemver(value.version)) addIssue(issues, "INVALID_SEMVER", "version", "version must be complete SemVer");
  if (!isContractVersion(value.contractVersion)) {
    addIssue(issues, "UNSUPPORTED_CONTRACT_VERSION", "contractVersion", "contractVersion must be major.minor[.patch]");
  } else if (!value.contractVersion.startsWith("1.")) {
    addIssue(issues, "UNSUPPORTED_CONTRACT_VERSION", "contractVersion", `only contract v1 is supported (expected ${PLUGIN_CONTRACT_VERSION})`);
  }

  validateRuntime(value.runtime, issues);
  validateCapabilities(value.capabilities, issues);
  validateLocales(value.locales, issues);
  validateConfig(value.config, issues);
  validateCompliance(value.compliance, issues);
  validatePermissions(value.permissions, issues);
  return issues;
}

/** A non-throwing type guard for registry startup checks. */
export function validatePluginManifest(value: unknown): value is PluginManifest {
  return getPluginManifestIssues(value).length === 0;
}

/** Throws a structured PluginError for the first issue, retaining the full issue list. */
export function assertPluginManifest(value: unknown): asserts value is PluginManifest {
  const issues = getPluginManifestIssues(value);
  if (issues.length > 0) {
    const first = issues[0];
    throw new PluginError(first.code, first.message, {
      path: first.path,
      issues,
    });
  }
}
