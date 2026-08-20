import assert from "node:assert/strict";
import test from "node:test";

import { planContentIdentityBackfill } from "@/lib/content-identity-backfill-plan";
import { DOUBAN_CONTENT_PLUGIN_ID } from "@/lib/plugins/adapters/douban-content";

const CONTENT_A = "550e8400-e29b-41d4-a716-446655440000";
const CONTENT_B = "550e8400-e29b-41d4-a716-446655440001";
const CONTENT_NEW = "550e8400-e29b-41d4-a716-446655440002";

function identity(documentId: string, contentId: string, doubanId: string) {
  return {
    documentId,
    contentId,
    externalRefs: [{
      provider_id: DOUBAN_CONTENT_PLUGIN_ID,
      external_id: doubanId,
    }],
  };
}

test("planner audits an existing matching content identity without rewriting it", () => {
  const plan = planContentIdentityBackfill(
    [{
      collection: "pan_resources",
      documentId: "resource-1",
      doubanId: "1292052",
      contentId: CONTENT_A,
    }],
    [identity("identity-1", CONTENT_A, "1292052")]
  );

  assert.equal(plan.alreadyConsistent, 1);
  assert.deepEqual(plan.assignments, []);
  assert.deepEqual(plan.newIdentities, []);
  assert.deepEqual(plan.conflicts, []);
});

test("planner fails closed when an existing content_id and Douban reference disagree", () => {
  const plan = planContentIdentityBackfill(
    [{
      collection: "pan_sync_targets",
      documentId: "target-1",
      doubanId: "1292052",
      contentId: CONTENT_A,
    }],
    [
      identity("identity-1", CONTENT_A, "1295644"),
      identity("identity-2", CONTENT_B, "1292052"),
    ]
  );

  assert.equal(plan.assignments.length, 0);
  assert.match(plan.conflicts[0]?.reason || "", /不同身份/);
});

test("planner refuses to infer a missing identity document from a stored content_id", () => {
  const plan = planContentIdentityBackfill(
    [{
      collection: "pan_resources",
      documentId: "resource-1",
      doubanId: "1292052",
      contentId: CONTENT_A,
    }],
    []
  );

  assert.equal(plan.assignments.length, 0);
  assert.match(plan.conflicts[0]?.reason || "", /没有对应的身份文档/);
});

test("planner refuses to attach a new Douban reference to an existing identity", () => {
  const plan = planContentIdentityBackfill(
    [{
      collection: "pan_resources",
      documentId: "resource-1",
      doubanId: "1292052",
      contentId: CONTENT_A,
    }],
    [identity("identity-1", CONTENT_A, "1295644")]
  );

  assert.equal(plan.assignments.length, 0);
  assert.match(plan.conflicts[0]?.reason || "", /不能自动推断/);
});

test("planner rejects duplicate external references before making assignments", () => {
  const plan = planContentIdentityBackfill(
    [{
      collection: "pan_resources",
      documentId: "resource-1",
      doubanId: "1292052",
      contentId: undefined,
    }],
    [
      identity("identity-1", CONTENT_A, "1292052"),
      identity("identity-2", CONTENT_B, "1292052"),
    ]
  );

  assert.equal(plan.assignments.length, 0);
  assert.ok(plan.conflicts.some((conflict) => /指向多个身份文档/.test(conflict.reason)));
});

test("planner gives all missing records for one Douban ID the same new identity", () => {
  const plan = planContentIdentityBackfill(
    [
      {
        collection: "pan_sync_targets",
        documentId: "target-1",
        doubanId: "1292052",
        contentId: undefined,
      },
      {
        collection: "pan_resources",
        documentId: "resource-1",
        doubanId: "1292052",
        contentId: "",
      },
    ],
    [],
    () => CONTENT_NEW
  );

  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.newIdentities, [{ doubanId: "1292052", contentId: CONTENT_NEW }]);
  assert.equal(plan.assignments.length, 2);
  assert.ok(plan.assignments.every((assignment) => assignment.contentId === CONTENT_NEW));
});
