import assert from "node:assert/strict";
import test from "node:test";
import { MongoClient } from "mongodb";

import { COLLECTIONS } from "@/lib/constants/db";
import { getMongoClient } from "@/lib/db";
import {
  PAN_CATALOG_PROJECTION_STATUSES,
  projectPanCatalogRun,
} from "@/lib/pan/scheduler";

const mongoUri = process.env.PLUGIN_JOB_REAL_MONGO_URI;

test(
  "Mongo shadow projection is durable, idempotent, and repairable",
  { skip: !mongoUri },
  async () => {
    assert.ok(mongoUri);
    const client = new MongoClient(mongoUri);
    const databaseName = `kerkerker_pan_projection_${process.pid}_${Date.now()}`;
    const previousUri = process.env.MONGODB_URI;
    const previousDbName = process.env.MONGODB_DB_NAME;
    process.env.MONGODB_URI = mongoUri;
    process.env.MONGODB_DB_NAME = databaseName;
    process.env.PAN_SYNC_CATALOG_JOB_MODE = "shadow";
    const runId = "legacy-projection-integration";
    try {
      await client.connect();
      const db = client.db(databaseName);
      const now = new Date().toISOString();
      await db.collection(COLLECTIONS.PAN_SYNC_RUNS).insertOne({
        run_id: runId,
        plugin_id: "kerkerker.kkpan-cloud-drive",
        plugin_version: "1.0.0",
        profile_id: "cn-default",
        profile: "cn-default",
        config_version: "runtime",
        actor: { type: "system", id: "integration" },
        idempotency_key: `pan-sync:${runId}`,
        task: "catalog",
        trigger: "manual",
        status: "queued",
        batch_limit: 5,
        max_batches: 1,
        generic_job_id: "resource.cloud-drive.catalog-sync",
        generic_job_mode: "shadow",
        generic_job_projection_status: "failed",
        generic_job_projection_attempts: 0,
        discovered: 0,
        queued: 0,
        processed: 0,
        synced: 0,
        empty: 0,
        failed: 0,
        imported: 0,
        refreshed: 0,
        disabled: 0,
        remaining: 0,
        progress_total: 0,
        completed_batches: 0,
        cancel_requested: false,
        event_seq: 0,
        created_at: now,
        updated_at: now,
        expires_at: new Date(Date.now() + 60_000),
      });

      const first = await projectPanCatalogRun(runId);
      assert.equal(first?.generic_job_projection_status, "succeeded");
      assert.equal(first?.generic_job_projection_attempts, 1);
      assert.ok(first?.generic_job_run_id);
      assert.ok(
        PAN_CATALOG_PROJECTION_STATUSES.includes(
          first?.generic_job_projection_status as (typeof PAN_CATALOG_PROJECTION_STATUSES)[number]
        )
      );

      const second = await projectPanCatalogRun(runId);
      assert.equal(second?.generic_job_projection_attempts, 1);
      assert.equal(
        await db.collection(COLLECTIONS.PLUGIN_JOBS).countDocuments({
          idempotency_key: first?.generic_job_idempotency_key,
        }),
        1
      );
    } finally {
      await client.db(databaseName).dropDatabase().catch(() => undefined);
      await client.close();
      await getMongoClient()?.close().catch(() => undefined);
      if (previousUri === undefined) delete process.env.MONGODB_URI;
      else process.env.MONGODB_URI = previousUri;
      if (previousDbName === undefined) delete process.env.MONGODB_DB_NAME;
      else process.env.MONGODB_DB_NAME = previousDbName;
      delete process.env.PAN_SYNC_CATALOG_JOB_MODE;
    }
  }
);
