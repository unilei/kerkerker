import { getActivePluginProfileId } from "@/lib/plugins/builtin-profiles";
import { createProfileInvocation } from "@/lib/plugins/invocation";
import { invokeProfilePlugin } from "@/lib/plugins/runtime";
import type {
  ContentCalendarCandidate,
  ContentCalendarRequest,
  ContentCandidate,
  ContentCatalogCandidate,
  ContentCatalogRequest,
  ContentSearchRequest,
  PluginPage,
} from "@/lib/plugins/types";

export interface ContentHostExecutionOptions {
  /** Defaults to the deployment-selected profile. Public callers cannot set it. */
  readonly profileId?: string;
  readonly requestId?: string;
  readonly runId?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

function invocationOptions(
  capability: "content.catalog" | "content.calendar" | "content.search",
  options: ContentHostExecutionOptions
) {
  const profileId = options.profileId || getActivePluginProfileId();
  const { context } = createProfileInvocation({
    profileId,
    capability,
    requestId: options.requestId,
    runId: options.runId,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
  return { profileId, context };
}

/** Server-only host facade used by jobs and repositories, never by browsers. */
export async function getContentCatalog(
  request: ContentCatalogRequest,
  options: ContentHostExecutionOptions = {}
): Promise<PluginPage<ContentCatalogCandidate>> {
  const invocation = invocationOptions("content.catalog", options);
  return invokeProfilePlugin<PluginPage<ContentCatalogCandidate>>({
    ...invocation,
    capability: "content.catalog",
    operation: "catalog",
    request,
  });
}

export async function getContentCalendar(
  request: ContentCalendarRequest,
  options: ContentHostExecutionOptions = {}
): Promise<PluginPage<ContentCalendarCandidate>> {
  const invocation = invocationOptions("content.calendar", options);
  return invokeProfilePlugin<PluginPage<ContentCalendarCandidate>>({
    ...invocation,
    capability: "content.calendar",
    operation: "calendar",
    request,
  });
}

export async function searchContent(
  request: ContentSearchRequest,
  options: ContentHostExecutionOptions = {}
): Promise<PluginPage<ContentCandidate>> {
  const invocation = invocationOptions("content.search", options);
  return invokeProfilePlugin<PluginPage<ContentCandidate>>({
    ...invocation,
    capability: "content.search",
    operation: "search",
    request,
  });
}
