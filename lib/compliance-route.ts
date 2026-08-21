import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import {
  ComplianceIdempotencyConflictError,
  ComplianceValidationError,
} from "@/lib/compliance-db";
import type { AuditActor } from "@/lib/compliance-types";

const MAX_REQUEST_ID_LENGTH = 200;
const MAX_ACTOR_ID_LENGTH = 200;

function boundedHeader(value: string | null, maxLength: number): string | undefined {
  const normalized = value?.trim();
  if (
    !normalized ||
    normalized.length > maxLength ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

/**
 * The current admin session is not user-addressable, so the actor identity is
 * supplied by a server-side deployment setting instead of a spoofable header.
 */
export function adminAuditActor(): AuditActor {
  const id = boundedHeader(
    process.env.ADMIN_AUDIT_ACTOR_ID || null,
    MAX_ACTOR_ID_LENGTH
  );
  return { type: "admin", id: id || "admin-session" };
}

export function requestAuditId(request: Pick<NextRequest, "headers">): string {
  return (
    boundedHeader(request.headers.get("x-request-id"), MAX_REQUEST_ID_LENGTH) ||
    randomUUID()
  );
}

export function complianceErrorResponse(error: unknown): {
  status: number;
  message: string;
} {
  if (error instanceof ComplianceValidationError || error instanceof RangeError) {
    return { status: 400, message: error.message };
  }
  if (error instanceof ComplianceIdempotencyConflictError) {
    return { status: 409, message: error.message };
  }
  return { status: 500, message: "合规数据操作失败" };
}

export function optionalQueryValue(
  value: string | null,
  maxLength = 200
): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (
    normalized.length > maxLength ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new ComplianceValidationError("查询参数格式无效");
  }
  return normalized;
}

export function boundedLimit(value: string | null, fallback = 50, max = 200): number {
  if (!value) return fallback;
  if (!/^\d+$/.test(value)) {
    throw new ComplianceValidationError("limit 必须是正整数");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new ComplianceValidationError("limit 必须是正整数");
  }
  return Math.min(parsed, max);
}
