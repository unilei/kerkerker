import { getActivePluginProfileId } from "@/lib/plugins/builtin-profiles";
import { createProfileInvocation } from "@/lib/plugins/invocation";
import { invokeProfilePlugin } from "@/lib/plugins/runtime";
import type {
  CloudDriveAvailabilityRequest,
  CloudDriveIncrementalRequest,
  CloudDriveResourceCandidate,
  CloudDriveSearchRequest,
  PluginPage,
} from "@/lib/plugins/types";

/**
 * Host-side execution options shared by cloud-drive jobs.
 *
 * The provider is selected by the deployment profile. Callers may carry a
 * request/run identifier, timeout, and cancellation signal, but they never
 * select a vendor adapter or read vendor environment variables themselves.
 */
export interface ResourceHostExecutionOptions {
  /** Defaults to the deployment-selected profile. */
  readonly profileId?: string;
  readonly requestId?: string;
  readonly runId?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}
function invocationOptions(
  operation: "search" | "incremental" | "availability",
  options: ResourceHostExecutionOptions
) {
  const profileId = options.profileId || getActivePluginProfileId();
  const { context } = createProfileInvocation({
    profileId,
    capability: "resource.cloud-drive",
    requestId: options.requestId,
    runId: options.runId,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
  return {
    profileId,
    context,
    capability: "resource.cloud-drive" as const,
    operation,
  };
}

/** Search a configured cloud-drive provider through the plugin boundary. */
export async function searchCloudDriveResources(
  request: CloudDriveSearchRequest,
  options: ResourceHostExecutionOptions = {}
): Promise<PluginPage<CloudDriveResourceCandidate>> {
  const invocation = invocationOptions("search", options);
  return invokeProfilePlugin<PluginPage<CloudDriveResourceCandidate>>({
    ...invocation,
    request,
  });
}

/** Read a provider's stable incremental feed through the plugin boundary. */
export async function incrementCloudDriveResources(
  request: CloudDriveIncrementalRequest,
  options: ResourceHostExecutionOptions = {}
): Promise<PluginPage<CloudDriveResourceCandidate>> {
  const invocation = invocationOptions("incremental", options);
  return invokeProfilePlugin<PluginPage<CloudDriveResourceCandidate>>({
    ...invocation,
    request,
  });
}

/** Check the availability of already discovered resources. */
export async function checkCloudDriveAvailability(
  request: CloudDriveAvailabilityRequest,
  options: ResourceHostExecutionOptions = {}
): Promise<readonly CloudDriveResourceCandidate[]> {
  const invocation = invocationOptions("availability", options);
  return invokeProfilePlugin<readonly CloudDriveResourceCandidate[]>({
    ...invocation,
    request,
  });
}
