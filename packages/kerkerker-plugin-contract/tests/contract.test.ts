import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  PLUGIN_CONTRACT_VERSION,
  PLUGIN_JOB_EVENT_KINDS,
  PLUGIN_JOB_EVENT_SCHEMA,
  PLUGIN_JOB_EVENT_STATUSES,
  type PluginJobEvent,
  isPluginCapabilityId,
  isPluginContractVersion,
  isPluginErrorEnvelope,
  isPluginJobEvent,
} from "../src/index.js";

const jobEventFixture = JSON.parse(
  readFileSync(new URL("../fixtures/plugin-job-event.v1.valid.json", import.meta.url), "utf8")
) as PluginJobEvent;
const invalidJobEventFixture = JSON.parse(
  readFileSync(new URL("../fixtures/plugin-job-event.v1.invalid.json", import.meta.url), "utf8")
) as unknown;
const jobEventSchema = JSON.parse(
  readFileSync(new URL("../schemas/plugin-job-event.v1.schema.json", import.meta.url), "utf8")
) as object;
const ajv = new Ajv2020({ allErrors: true, strict: true });
const addFormats = createRequire(import.meta.url)("ajv-formats") as (instance: Ajv2020) => Ajv2020;
addFormats(ajv);
const validateJobEventSchema = ajv.compile(jobEventSchema);

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };
type MutableJobEvent = Mutable<Omit<PluginJobEvent, "metadata" | "progress">> & {
  metadata: Mutable<PluginJobEvent["metadata"]>;
  progress: Mutable<PluginJobEvent["progress"]>;
};

function cloneJobEvent(): MutableJobEvent {
  return structuredClone(jobEventFixture) as MutableJobEvent;
}

test("v1 contract exposes stable capability and version guards", () => {
  assert.equal(PLUGIN_CONTRACT_VERSION, "1.0.0");
  assert.equal(isPluginCapabilityId("content.catalog"), true);
  assert.equal(isPluginCapabilityId("douban.catalog"), false);
  assert.equal(isPluginContractVersion("1.0"), true);
  assert.equal(isPluginContractVersion("1.0.0"), true);
  assert.equal(isPluginContractVersion("v1"), false);
});

test("error envelopes are safe to transport across a sidecar boundary", () => {
  assert.equal(
    isPluginErrorEnvelope({
      error: { code: "UPSTREAM_ERROR", message: "temporary failure", retryable: true },
    }),
    true
  );
  assert.equal(isPluginErrorEnvelope({ error: { code: "" } }), false);
  assert.equal(isPluginErrorEnvelope({ message: "not an envelope" }), false);
});

test("job event v1 golden fixture stays transport-neutral", () => {
  assert.equal(validateJobEventSchema(jobEventFixture), true, JSON.stringify(validateJobEventSchema.errors));
  assert.equal(isPluginJobEvent(jobEventFixture), true);
  assert.equal(jobEventFixture.schema, PLUGIN_JOB_EVENT_SCHEMA);
  assert.equal(jobEventFixture.event_id, `${jobEventFixture.metadata.run_id}:${jobEventFixture.sequence}`);
  assert.equal(PLUGIN_JOB_EVENT_KINDS.includes(jobEventFixture.kind), true);
  assert.equal(PLUGIN_JOB_EVENT_STATUSES.includes(jobEventFixture.status), true);
  assert.equal(
    jobEventFixture.progress.created + jobEventFixture.progress.failed + jobEventFixture.progress.skipped,
    jobEventFixture.progress.processed
  );
});

test("job event schema and semantic guard reject invalid state and cross-field data", () => {
  assert.equal(validateJobEventSchema(invalidJobEventFixture), false);
  assert.equal(isPluginJobEvent(invalidJobEventFixture), false);

  const invalidStarted = cloneJobEvent();
  invalidStarted.kind = "started";
  assert.equal(validateJobEventSchema(invalidStarted), false);

  const failedWithoutError = cloneJobEvent();
  failedWithoutError.kind = "finished";
  failedWithoutError.status = "failed";
  assert.equal(validateJobEventSchema(failedWithoutError), false);

  const mismatchedId = cloneJobEvent();
  mismatchedId.event_id = "refresh-contract-1:2";
  assert.equal(validateJobEventSchema(mismatchedId), true);
  assert.equal(isPluginJobEvent(mismatchedId), false);

  const invalidProgress = cloneJobEvent();
  invalidProgress.progress.created = 4;
  assert.equal(validateJobEventSchema(invalidProgress), true);
  assert.equal(isPluginJobEvent(invalidProgress), false);

  const invalidDate = cloneJobEvent();
  invalidDate.occurred_at = "2026-02-30T24:00:00Z";
  assert.equal(isPluginJobEvent(invalidDate), false);
});
