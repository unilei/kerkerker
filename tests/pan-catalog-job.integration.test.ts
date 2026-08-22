import assert from "node:assert/strict";
import test from "node:test";
import { MongoClient } from "mongodb";

import {
  enqueuePanCatalogJobProjection,
  PAN_CATALOG_JOB_ID,
} from "@/lib/pan/catalog-job";
import { PluginJobRunner } from "@/lib/plugins/job-runner";
import { createMongoPluginJobStore } from "@/lib/plugins/mongo-job-store";

const mongoUri = process.env.PLUGIN_JOB_REAL_MONGO_URI;

test(
  "Mongo shadow catalog projection is excluded, then promoted by CAS",
  { skip: !mongoUri },
  async () => {
    assert.ok(mongoUri);
    const client = new MongoClient(mongoUri);
    const databaseName = `kerkerker_pan_catalog_${process.pid}_${Date.now()}`;
    try {
      await client.connect();
      const db = client.db(databaseName);
      const collection = db.collection("plugin_jobs");
      await collection.createIndex({ run_id: 1 }, { unique: true });
      await collection.createIndex({ idempotency_key: 1 }, { unique: true });
      const runner = new PluginJobRunner(createMongoPluginJobStore(db));
      const source = {
        runId: "legacy-mongo-run",
        trigger: "scheduled" as const,
        batchLimit: 5,
        maxBatches: 100,
        scheduleSlot: "catalog:2026-08-23",
        pluginId: "kerkerker.kkpan-cloud-drive",
        pluginVersion: "1.0.0",
        profileId: "cn-default",
        profile: "cn-default",
        configVersion: "runtime",
        actor: { type: "system" as const, id: "pan-scheduler" },
      };

      const shadow = await enqueuePanCatalogJobProjection(runner, source, "shadow");
      assert.equal(shadow?.job_id, PAN_CATALOG_JOB_ID);
      assert.equal(shadow?.host_claimable, false);
      assert.equal(
        await runner.claimNext({ owner: "mongo-host", jobIds: [PAN_CATALOG_JOB_ID] }),
        null
      );

      const promoted = await enqueuePanCatalogJobProjection(runner, source, "cutover", {
        promoteShadow: true,
      });
      assert.equal(promoted?.run_id, shadow?.run_id);
      assert.equal(promoted?.host_claimable, true);
      assert.equal(promoted?.metadata.shadow, false);
      const claimed = await runner.claimNext({
        owner: "mongo-host",
        jobIds: [PAN_CATALOG_JOB_ID],
      });
      assert.equal(claimed?.run_id, shadow?.run_id);
    } finally {
      await client.db(databaseName).dropDatabase().catch(() => undefined);
      await client.close();
    }
  }
);
