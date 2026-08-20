/** Error vocabulary shared by manifest validation and plugin execution. */
export const PLUGIN_ERROR_CODES = {
  INVALID_MANIFEST: "INVALID_MANIFEST",
  INVALID_PLUGIN_ID: "INVALID_PLUGIN_ID",
  INVALID_SEMVER: "INVALID_SEMVER",
  UNSUPPORTED_CONTRACT_VERSION: "UNSUPPORTED_CONTRACT_VERSION",
  INVALID_RUNTIME: "INVALID_RUNTIME",
  UNKNOWN_CAPABILITY: "UNKNOWN_CAPABILITY",
  DUPLICATE_CAPABILITY: "DUPLICATE_CAPABILITY",
  INVALID_CAPABILITY_VERSION: "INVALID_CAPABILITY_VERSION",
  INVALID_CLOUD_DRIVE_FEATURE: "INVALID_CLOUD_DRIVE_FEATURE",
  DUPLICATE_CONFIG_FIELD: "DUPLICATE_CONFIG_FIELD",
  MISSING_COMPLIANCE: "MISSING_COMPLIANCE",
  INVALID_COMPLIANCE: "INVALID_COMPLIANCE",
  INVALID_NETWORK_HOST: "INVALID_NETWORK_HOST",
  DANGEROUS_NETWORK_HOST: "DANGEROUS_NETWORK_HOST",
  INVALID_PERMISSION: "INVALID_PERMISSION",
  CAPABILITY_UNAVAILABLE: "CAPABILITY_UNAVAILABLE",
  UNSUPPORTED_CAPABILITY: "UNSUPPORTED_CAPABILITY",
  CONFIGURATION_ERROR: "CONFIGURATION_ERROR",
  EXECUTION_FAILED: "EXECUTION_FAILED",
  EXECUTION_CANCELLED: "EXECUTION_CANCELLED",
  UPSTREAM_ERROR: "UPSTREAM_ERROR",
} as const;

export type PluginErrorCode =
  (typeof PLUGIN_ERROR_CODES)[keyof typeof PLUGIN_ERROR_CODES];

export interface PluginValidationIssue {
  readonly code: PluginErrorCode;
  readonly path: string;
  readonly message: string;
}

export interface PluginErrorOptions {
  readonly cause?: unknown;
  readonly path?: string;
  readonly issues?: readonly PluginValidationIssue[];
}

/** Structured error that can cross a host/sidecar boundary without stack parsing. */
export class PluginError extends Error {
  readonly code: PluginErrorCode;
  readonly path?: string;
  readonly issues?: readonly PluginValidationIssue[];

  constructor(
    code: PluginErrorCode,
    message: string,
    options: PluginErrorOptions = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "PluginError";
    this.code = code;
    this.path = options.path;
    this.issues = options.issues;
  }
}

export function isPluginError(error: unknown): error is PluginError {
  return error instanceof PluginError;
}
