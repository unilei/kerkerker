import assert from "node:assert/strict";
import test from "node:test";
import { MongoClient } from "mongodb";

import { COLLECTIONS } from "@/lib/constants/db";
import { getMongoClient } from "@/lib/db";
import {
  ContentIdentityConflictError,
  findContentIdentityById,
  linkExternalReferenceToContentIdentity,
} from "@/lib/content-identity-db";
import { TMDB_CONTENT_PLUGIN_ID } from "@/lib/plugins/adapters/tmdb-content";

const mongoUri = process.env.PLUGIN_JOB_REAL_MONGO_URI;
const CONTENT_ID = "550e8400-e29b-41d4-a716-446655440000";
const OTHER_CONTENT_ID = "550e8400-e29b-41d4-a716-446655440001";

test(
  "Mongo identity linking is exact, idempotent, and conflict-safe",
  { skip: !mongoUri },
  async () => {
    assert.ok(mongoUri);
    const client = new MongoClient(mongoUri);
    const databaseName = `kerkerker_identity_link_${process.pid}_${Date.now()}`;
    const previousUri = process.env.MONGODB_URI;
    const previousDbName = process.env.MONGODB_DB_NAME;
    process.env.MONGODB_URI = mongoUri;
    process.env.MONGODB_DB_NAME = databaseName;
    try {
      await client.connect();
      const db = client.db(databaseName);
      const now = new Date().toISOString();
      await db.collection(COLLECTIONS.CONTENT_IDENTITIES).insertMany([
        {
          content_id: CONTENT_ID,
          external_refs: [
            { provider_id: "kerkerker.douban-content", external_id: "1292052" },
          ],
          created_at: now,
          updated_at: now,
        },
        {
          content_id: OTHER_CONTENT_ID,
          external_refs: [
            { provider_id: "kerkerker.douban-content", external_id: "1295644" },
          ],
          created_at: now,
          updated_at: now,
        },
      ]);

      const first = await linkExternalReferenceToContentIdentity(CONTENT_ID, {
        providerId: TMDB_CONTENT_PLUGIN_ID,
        externalId: "603",
        canonicalUrl: "https://www.themoviedb.org/movie/603",
      });
      assert.equal(first.contentId, CONTENT_ID);
      assert.equal(first.externalRefs.length, 2);

      const replay = await linkExternalReferenceToContentIdentity(CONTENT_ID, {
        providerId: TMDB_CONTENT_PLUGIN_ID,
        externalId: "603",
      });
      assert.equal(replay.externalRefs.length, 2);
      assert.equal(
        await db.collection(COLLECTIONS.CONTENT_IDENTITIES).countDocuments({
          "external_refs.provider_id": TMDB_CONTENT_PLUGIN_ID,
          "external_refs.external_id": "603",
        }),
        1
      );

      await assert.rejects(
        () =>
          linkExternalReferenceToContentIdentity(OTHER_CONTENT_ID, {
            providerId: TMDB_CONTENT_PLUGIN_ID,
            externalId: "603",
          }),
        (error: unknown) => error instanceof ContentIdentityConflictError
      );
      assert.equal(await findContentIdentityById("550e8400-e29b-41d4-a716-446655440002"), null);
      await assert.rejects(
        () =>
          linkExternalReferenceToContentIdentity("550e8400-e29b-41d4-a716-446655440002", {
            providerId: TMDB_CONTENT_PLUGIN_ID,
            externalId: "999",
          }),
        (error: unknown) => error instanceof RangeError && /尚未解析/.test(error.message)
      );
    } finally {
      await client.db(databaseName).dropDatabase().catch(() => undefined);
      await client.close();
      await getMongoClient()?.close().catch(() => undefined);
      if (previousUri === undefined) delete process.env.MONGODB_URI;
      else process.env.MONGODB_URI = previousUri;
      if (previousDbName === undefined) delete process.env.MONGODB_DB_NAME;
      else process.env.MONGODB_DB_NAME = previousDbName;
    }
  }
);
