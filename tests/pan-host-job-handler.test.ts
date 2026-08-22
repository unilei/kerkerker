import assert from "node:assert/strict";
import test from "node:test";

import {
  PAN_CATALOG_JOB_ID,
} from "@/lib/pan/catalog-job";
import {
  createPanCatalogHostHandlerRegistration,
  createPanCatalogHostJobHandler,
  type PanCatalogHostHandlerDependencies,
} from "@/lib/pan/host-job-handler";
import {
  KKPAN_PLUGIN_ID,
  kkpanCloudDriveManifest,
} from "@/lib/plugins/adapters/kkpan-cloud-drive";
import {
  PluginJobError,
  PLUGIN_JOB_ERROR_CODES,
  type PluginJobRun,
} from "@/lib/plugins/job-runner";
import type { PluginJobExecutionContext } from "@/lib/plugins/job-executor";
import type {
  PanSyncTarget,
  PanSyncTargetBatchHooks,
  PanSyncTargetBatchResult,
} from "@/lib/pan/catalog-sync";

const NOW = "2026-08-23T00:00:00.000Z";

function makeRun(overrides: Partial<PluginJobRun> = {}): PluginJobRun {
  return {
    run_id: "pan-catalog:test-run",
    job_id: PAN_CATALOG_JOB_ID,
    control_mode: "host",
    plugin_id: KKPAN_PLUGIN_ID,
    plugin_version: kkpanCloudDriveManifest.version,
    profile_id: "cn-default",
    profile: "cn-default",
    config_version: "test-config",
    actor: { type: "system", id: "test" },
    idempotency_key: "test:pan-catalog",
    status: "running",
    attempt: 1,
    retry_policy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    lease_fence: 17,
    lease: {
      owner: "test-host",
      token: "lease-token-must-never-leak",
      fence: 17,
      acquired_at: NOW,
      heartbeat_at: NOW,
      expires_at: "2026-08-23T01:00:00.000Z",
    },
    cancel_requested: false,
    progress: { total: 0, processed: 0, created: 0, failed: 0, skipped: 0 },
    metadata: {
      source: "pan-scheduler",
      task: "catalog",
      migration_mode: "cutover",
      shadow: false,
      batch_limit: 2,
      max_batches: 2,
    },
    revision: 1,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makeContext(
  run: PluginJobRun = makeRun(),
  options: {
    signal?: AbortSignal;
    isCancellationRequested?: () => Promise<boolean>;
  } = {}
): PluginJobExecutionContext & {
  progress: Record<string, number>[];
  cursors: (string | undefined)[];
} {
  const progress: Record<string, number>[] = [];
  const cursors: (string | undefined)[] = [];
  const signal = options.signal || new AbortController().signal;
  return {
    run,
    credential: {
      owner: "test-host",
      token: "lease-token-must-never-leak",
      fence: 17,
    },
    signal,
    progress,
    cursors,
    reportProgress: async (patch) => {
      progress.push({ ...patch } as Record<string, number>);
      return run;
    },
    setCursor: async (cursor) => {
      cursors.push(cursor);
      return run;
    },
    isCancellationRequested:
      options.isCancellationRequested || (async () => false),
  };
}

function target(id: string): PanSyncTarget {
  return {
    douban_id: id,
    title: `影片 ${id}`,
    status: "syncing",
    attempts: 1,
    resources_count: 0,
    created_at: NOW,
    updated_at: NOW,
  };
}

function batch(
  overrides: Partial<PanSyncTargetBatchResult> = {}
): PanSyncTargetBatchResult {
  return {
    processed: 2,
    synced: 1,
    empty: 1,
    failed: 0,
    imported: 4,
    refreshed: 0,
    disabled: 0,
    remaining: 0,
    stats: {
      total: 2,
      pending: 0,
      syncing: 0,
      synced: 1,
      empty: 1,
      failed: 0,
    },
    ...overrides,
  };
}

function makeDependencies(
  result: PanSyncTargetBatchResult = batch(),
  discovery: {
    discovered?: number;
    upserted?: number;
    sourceErrors?: string[];
  } = {}
): {
  dependencies: Partial<PanCatalogHostHandlerDependencies>;
  calls: {
    discovery?: Record<string, unknown>;
    queueDue: number;
    batches: {
      limit: number;
      owner: string;
      hooks: PanSyncTargetBatchHooks;
    }[];
  };
} {
  const calls = {
    queueDue: 0,
    batches: [] as {
      limit: number;
      owner: string;
      hooks: PanSyncTargetBatchHooks;
    }[],
  };
  const injected: Partial<PanCatalogHostHandlerDependencies> = {
    discoverAndEnqueue: async () => {
      return {
        discovered: discovery.discovered ?? 2,
        upserted: discovery.upserted ?? discovery.discovered ?? 2,
        sourceErrors: discovery.sourceErrors ?? [],
      };
    },
    queueDue: async () => {
      calls.queueDue += 1;
      return 0;
    },
    runBatch: async (limit, owner, _doubanId, hooks) => {
      calls.batches.push({
        limit: limit ?? 0,
        owner: owner ?? "",
        hooks: hooks || {},
      });
      await hooks?.onTargetStart?.(target("250"));
      return result;
    },
  };
  return { dependencies: injected, calls };
}

test("KKPAN registration is static and forwards fenced execution identity", async () => {
  const { dependencies, calls } = makeDependencies();
  const registration = createPanCatalogHostHandlerRegistration({ dependencies });
  assert.equal(registration.jobId, PAN_CATALOG_JOB_ID);
  assert.equal(registration.pluginId, KKPAN_PLUGIN_ID);
  assert.equal(registration.pluginVersion, kkpanCloudDriveManifest.version);

  const context = makeContext();
  const result = await registration.execute(context);

  assert.equal(result?.status, "succeeded");
  assert.equal(calls.queueDue, 1);
  assert.equal(calls.batches.length, 1);
  assert.equal(calls.batches[0]?.owner, "pan-catalog:test-run:17");
  assert.equal(calls.batches[0]?.hooks.execution?.runId, "pan-catalog:test-run");
  assert.equal(calls.batches[0]?.hooks.execution?.profileId, "cn-default");
  assert.equal(calls.batches[0]?.hooks.execution?.signal, context.signal);
  assert.deepEqual(context.progress.at(-1), {
    total: 2,
    processed: 2,
    created: 1,
    failed: 0,
    skipped: 1,
  });
  assert.equal(context.progress.at(-1)!.created + context.progress.at(-1)!.failed + context.progress.at(-1)!.skipped, 2);
});

test("resource imports do not inflate generic target progress", async () => {
  const { dependencies } = makeDependencies(
    batch({ processed: 2, synced: 2, empty: 0, imported: 99 })
  );
  const context = makeContext();
  const result = await createPanCatalogHostJobHandler({ dependencies })(context);

  assert.equal(result.status, "succeeded");
  const progress = context.progress.at(-1)!;
  assert.deepEqual(progress, {
    total: 2,
    processed: 2,
    created: 2,
    failed: 0,
    skipped: 0,
  });
});

test("source errors with no discovered targets fail, while partial discovery is partial", async () => {
  const failedDiscovery = makeDependencies(undefined, {
    discovered: 0,
    upserted: 0,
    sourceErrors: ["authorization=secret-token"],
  });
  const failed = await createPanCatalogHostJobHandler({
    dependencies: failedDiscovery.dependencies,
  })(makeContext());
  assert.equal(failed.status, "failed");
  assert.equal(failed.error?.code, "PAN_CATALOG_SOURCE_FAILURE");
  assert.ok(!failed.error?.message.includes("secret-token"));
  assert.equal(failedDiscovery.calls.queueDue, 0);

  const partialDiscovery = makeDependencies(batch(), {
    discovered: 2,
    sourceErrors: ["one source unavailable"],
  });
  const partial = await createPanCatalogHostJobHandler({
    dependencies: partialDiscovery.dependencies,
  })(makeContext());
  assert.equal(partial.status, "partial");
  assert.equal(partial.error?.code, "PAN_CATALOG_SOURCE_PARTIAL");
});

test("signal and cancellation stop work cooperatively", async () => {
  const controller = new AbortController();
  controller.abort("test cancellation");
  const aborted = makeDependencies();
  const abortedResult = await createPanCatalogHostJobHandler({
    dependencies: aborted.dependencies,
  })(makeContext(makeRun(), { signal: controller.signal }));
  assert.equal(abortedResult.status, "cancelled");
  assert.equal(aborted.calls.queueDue, 0);

  let checks = 0;
  const requested = makeDependencies();
  const requestedResult = await createPanCatalogHostJobHandler({
    dependencies: requested.dependencies,
  })(makeContext(makeRun(), {
    isCancellationRequested: async () => {
      checks += 1;
      return checks >= 2;
    },
  }));
  assert.equal(requestedResult.status, "cancelled");
  assert.equal(requested.calls.queueDue, 0);
});

test("handler errors are returned without leaking lease credentials", async () => {
  const injected: Partial<PanCatalogHostHandlerDependencies> = {
    discoverAndEnqueue: async () => ({ discovered: 1, upserted: 1, sourceErrors: [] }),
    queueDue: async () => 0,
    runBatch: async () => {
      throw new Error("request failed: token=lease-token-must-never-leak");
    },
  };
  const result = await createPanCatalogHostJobHandler({ dependencies: injected })(
    makeContext()
  );
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "PAN_CATALOG_HANDLER_ERROR");
  assert.ok(!result.error?.message.includes("lease-token-must-never-leak"));
});

test("production compatibility projection receives progress and terminal status", async () => {
  const snapshots: Array<{ status?: string; processed: number }> = [];
  const { dependencies } = makeDependencies();
  dependencies.syncLegacyProjection = async ({ run, status }) => {
    snapshots.push({ status, processed: run.progress.processed });
  };
  const result = await createPanCatalogHostJobHandler({ dependencies })(
    makeContext()
  );
  assert.equal(result.status, "succeeded");
  assert.ok(snapshots.length >= 2);
  assert.equal(snapshots.at(-1)?.status, "succeeded");
});

test("lease loss is propagated so the generic executor can fence finalization", async () => {
  const injected: Partial<PanCatalogHostHandlerDependencies> = {
    discoverAndEnqueue: async () => ({ discovered: 1, upserted: 1, sourceErrors: [] }),
    queueDue: async () => 0,
    runBatch: async () => {
      throw new PluginJobError(
        PLUGIN_JOB_ERROR_CODES.LEASE_REQUIRED,
        "lease no longer valid"
      );
    },
  };
  await assert.rejects(
    createPanCatalogHostJobHandler({ dependencies: injected })(makeContext()),
    (error: unknown) =>
      error instanceof PluginJobError &&
      error.code === PLUGIN_JOB_ERROR_CODES.LEASE_REQUIRED
  );
});
