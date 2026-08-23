import { NextRequest, NextResponse } from "next/server";

import { requireAdminRequest } from "@/lib/admin-route";
import {
  adminAuditActor,
  requestAuditId,
} from "@/lib/compliance-route";
import { recordAudit, type AuditEventInput } from "@/lib/compliance-db";
import { pluginRegistry } from "@/lib/plugins";
import type { PluginDescriptor } from "@/lib/plugins/registry";
import {
  getPluginInstallationStore,
  PLUGIN_INSTALLATION_STATUSES,
  PluginInstallationTransitionError,
  PluginInstallationValidationError,
  type PluginInstallationRecord,
  type PluginInstallationStatus,
  type PluginInstallationStore,
} from "@/lib/plugins/installation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 16 * 1024;
const ACTIONS = ["install", "enable", "disable", "uninstall", "retry"] as const;
type InstallationAction = (typeof ACTIONS)[number];

class InvalidInstallationRequestError extends RangeError {}

export interface PluginInstallationsRouteDependencies {
  listPlugins(): readonly PluginDescriptor[];
  getStore(): Promise<PluginInstallationStore>;
  writeAudit(input: AuditEventInput): Promise<unknown>;
}

const defaultDependencies: PluginInstallationsRouteDependencies = {
  listPlugins: () => pluginRegistry.list(),
  getStore: getPluginInstallationStore,
  async writeAudit(input) {
    // The in-memory installation store is intentionally only a local/test
    // fallback. In that mode there is no durable audit backend either, so do
    // not turn a useful local state transition into a misleading 500.
    if (!process.env.MONGODB_URI) return;
    await recordAudit(input);
  },
};

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedPluginId(value: unknown): string {
  if (typeof value !== "string") throw new InvalidInstallationRequestError("plugin_id 格式无效");
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > 200 ||
    !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)*$/.test(normalized)
  ) {
    throw new InvalidInstallationRequestError("plugin_id 格式无效");
  }
  return normalized;
}

function parseAction(value: unknown): InstallationAction {
  if (typeof value !== "string" || !ACTIONS.includes(value as InstallationAction)) {
    throw new InvalidInstallationRequestError(
      `action 必须是 ${ACTIONS.join("、")} 之一`
    );
  }
  return value as InstallationAction;
}

async function parseBody(request: NextRequest): Promise<{
  action: InstallationAction;
  pluginId: string;
}> {
  const contentType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    throw new InvalidInstallationRequestError("插件安装操作必须使用 application/json");
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_BODY_BYTES) {
      throw new InvalidInstallationRequestError("插件安装请求体过大");
    }
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new InvalidInstallationRequestError("请求体必须是合法 JSON 对象");
  }
  if (!isObject(body)) {
    throw new InvalidInstallationRequestError("请求体必须是 JSON 对象");
  }
  const unknownKeys = Object.keys(body).filter(
    (key) => key !== "action" && key !== "plugin_id"
  );
  if (unknownKeys.length > 0) {
    throw new InvalidInstallationRequestError("请求体包含不支持的字段");
  }
  return {
    action: parseAction(body.action),
    pluginId: boundedPluginId(body.plugin_id),
  };
}

function defaultInstallation(descriptor: PluginDescriptor): PluginInstallationRecord {
  return {
    pluginId: descriptor.id,
    pluginVersion: descriptor.version,
    status: "available",
    updatedAt: new Date(0).toISOString(),
  };
}

function publicInstallation(record: PluginInstallationRecord) {
  return {
    plugin_id: record.pluginId,
    plugin_version: record.pluginVersion,
    status: record.status,
    ...(record.installedAt ? { installed_at: record.installedAt } : {}),
    ...(record.enabledAt ? { enabled_at: record.enabledAt } : {}),
    ...(record.disabledAt ? { disabled_at: record.disabledAt } : {}),
    ...(record.failedAt ? { failed_at: record.failedAt } : {}),
    ...(record.uninstalledAt ? { uninstalled_at: record.uninstalledAt } : {}),
    updated_at: record.updatedAt,
    ...(record.error
      ? {
          error: {
            ...(record.error.code ? { code: record.error.code } : {}),
            message: record.error.message,
          },
        }
      : {}),
  };
}

function targetStatus(action: InstallationAction): PluginInstallationStatus {
  switch (action) {
    case "install":
    case "retry":
      return "installed";
    case "enable":
      return "enabled";
    case "disable":
      return "disabled";
    case "uninstall":
      return "available";
  }
}

function safeAuditReason(action: InstallationAction): string {
  return `插件中心操作：${action}`;
}

export function createPluginInstallationsRouteHandlers(
  dependencies: PluginInstallationsRouteDependencies = defaultDependencies
) {
  return {
    async GET(request: NextRequest) {
      const unauthorized = requireAdminRequest(request);
      if (unauthorized) return unauthorized;

      try {
        const descriptors = dependencies.listPlugins();
        const records = await dependencies.getStore().then((store) => store.list());
        const byId = new Map(records.map((record) => [record.pluginId, record]));
        const plugins = descriptors.map((descriptor) => ({
          ...descriptor,
          installation: publicInstallation(
            byId.get(descriptor.id) || defaultInstallation(descriptor)
          ),
        }));
        return NextResponse.json({
          code: 200,
          message: "获取成功",
          data: {
            statuses: PLUGIN_INSTALLATION_STATUSES,
            writable: true,
            plugins,
          },
        });
      } catch (error) {
        console.error(
          "获取插件安装状态失败:",
          error instanceof Error ? error.name : "unknown"
        );
        return NextResponse.json(
          { code: 500, message: "获取插件安装状态失败", data: null },
          { status: 500 }
        );
      }
    },

    async POST(request: NextRequest) {
      const unauthorized = requireAdminRequest(request);
      if (unauthorized) return unauthorized;

      let body: { action: InstallationAction; pluginId: string };
      try {
        body = await parseBody(request);
      } catch (error) {
        const message =
          error instanceof InvalidInstallationRequestError
            ? error.message
            : "插件安装请求无效";
        return NextResponse.json({ code: 400, message, data: null }, { status: 400 });
      }

      const descriptor = dependencies
        .listPlugins()
        .find((plugin) => plugin.id === body.pluginId);
      if (!descriptor) {
        return NextResponse.json(
          { code: 400, message: "只能安装可信静态注册插件", data: null },
          { status: 400 }
        );
      }

      try {
        const store = await dependencies.getStore();
        const actor = adminAuditActor();
        const record = await store.transition(body.pluginId, {
          status: targetStatus(body.action),
          pluginVersion: descriptor.version,
          updatedBy: { type: "admin", ...(actor.id ? { id: actor.id } : {}) },
        });
        await dependencies.writeAudit({
          idempotencyKey: `${requestAuditId(request)}:plugin.installation:${body.pluginId}:${body.action}`,
          actor,
          action: `plugin.installation.${body.action}`,
          target: { type: "plugin", id: body.pluginId, pluginId: body.pluginId },
          pluginId: body.pluginId,
          pluginVersion: descriptor.version,
          reason: safeAuditReason(body.action),
          metadata: { status: record.status },
        });
        return NextResponse.json({
          code: 200,
          message: "插件状态已更新",
          data: { plugin: descriptor, installation: publicInstallation(record) },
        });
      } catch (error) {
        if (
          error instanceof PluginInstallationTransitionError ||
          error instanceof PluginInstallationValidationError
        ) {
          return NextResponse.json(
            { code: 409, message: error.message, data: null },
            { status: 409 }
          );
        }
        console.error(
          "更新插件安装状态失败:",
          error instanceof Error ? error.name : "unknown"
        );
        return NextResponse.json(
          { code: 500, message: "更新插件安装状态失败", data: null },
          { status: 500 }
        );
      }
    },
  };
}

const handlers = createPluginInstallationsRouteHandlers();
export const GET = handlers.GET;
export const POST = handlers.POST;
