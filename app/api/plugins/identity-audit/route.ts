import { NextRequest, NextResponse } from "next/server";

import { requireAdminRequest } from "@/lib/admin-route";
import { loadContentIdentityAuditReport } from "@/lib/content-identity-audit-db";
import type { ContentIdentityAuditIssue, ContentIdentityAuditReport } from "@/lib/content-identity-audit";
import { boundedLimit } from "@/lib/compliance-route";

export const dynamic = "force-dynamic";

const DEFAULT_ISSUE_LIMIT = 100;
const MAX_ISSUE_LIMIT = 200;

export interface IdentityAuditRouteDependencies {
  loadReport(): Promise<ContentIdentityAuditReport>;
}

const defaultDependencies: IdentityAuditRouteDependencies = {
  loadReport: loadContentIdentityAuditReport,
};

function parseConflictsOnly(request: NextRequest): boolean {
  const value = request.nextUrl.searchParams.get("conflicts_only");
  if (value === null || value === "false") return false;
  if (value === "true") return true;
  throw new RangeError("conflicts_only 仅支持 true 或 false");
}

function boundedIssues(
  issues: readonly ContentIdentityAuditIssue[],
  limit: number,
  conflictsOnly: boolean
) {
  const selected = conflictsOnly
    ? issues.filter((item) => item.severity === "conflict")
    : [...issues];
  return {
    issues: selected.slice(0, limit),
    issueCount: selected.length,
    issuesTruncated: selected.length > limit,
  };
}

/**
 * Read-only operational view of content identity consistency.
 * `conflicts_only=true` is explicit even though current audit issues are all
 * blocking conflicts, leaving room for non-blocking findings later.
 */
export function createIdentityAuditRouteHandlers(
  dependencies: IdentityAuditRouteDependencies = defaultDependencies
) {
  return {
    async GET(request: NextRequest) {
      const unauthorized = requireAdminRequest(request);
      if (unauthorized) return unauthorized;

      try {
        const params = request.nextUrl.searchParams;
        const limit = boundedLimit(
          params.get("limit"),
          DEFAULT_ISSUE_LIMIT,
          MAX_ISSUE_LIMIT
        );
        const conflictsOnly = parseConflictsOnly(request);
        const report = await dependencies.loadReport();
        const issueView = boundedIssues(report.issues, limit, conflictsOnly);
        return NextResponse.json({
          code: 200,
          message: "获取成功",
          data: {
            generated_at: new Date().toISOString(),
            report: {
              ...report,
              issues: issueView.issues,
              issueCount: issueView.issueCount,
              issuesTruncated: issueView.issuesTruncated,
            },
            filters: {
              conflictsOnly,
              issueLimit: limit,
            },
          },
        });
      } catch (error) {
        const message =
          error instanceof RangeError
            ? error.message
            : "获取内容身份审计失败";
        const status = error instanceof RangeError ? 400 : 500;
        if (status === 500) console.error("获取内容身份审计失败:", error);
        return NextResponse.json(
          { code: status, message, data: null },
          { status }
        );
      }
    },
  };
}

const handlers = createIdentityAuditRouteHandlers();
export const GET = handlers.GET;
