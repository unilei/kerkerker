import assert from "node:assert/strict";
import test from "node:test";
import { MongoClient } from "mongodb";

import {
  ImageMirrorService,
  type ImageMirrorInput,
} from "@/lib/plugins/image-mirror";
import { createMongoImageMirrorRepository } from "@/lib/plugins/mongo-image-mirror";
import { COLLECTIONS } from "@/lib/constants/db";

const mongoUri = process.env.PLUGIN_JOB_REAL_MONGO_URI;
const INPUT: ImageMirrorInput = {
  contentId: "550e8400-e29b-41d4-a716-446655440010",
  providerId: "kerkerker.tmdb-content",
  externalId: "603",
  purpose: "poster",
  originalUrl: "https://image.tmdb.org/t/p/w500/example.jpg",
};

test(
  "Mongo image mirror records survive a new repository instance and retain invalidation state",
  { skip: !mongoUri },
  async () => {
    assert.ok(mongoUri);
    const client = new MongoClient(mongoUri);
    const databaseName = `kerkerker_image_mirror_${process.pid}_${Date.now()}`;
    try {
      await client.connect();
      const db = client.db(databaseName);
      const repository = createMongoImageMirrorRepository(db);
      let uploads = 0;
      const service = new ImageMirrorService({
        repository,
        assertUrl: async (url) => new URL(url),
        fetcher: {
          async fetch() {
            return {
              body: new Uint8Array([4, 5, 6]),
              contentType: "image/jpeg",
              width: 500,
              height: 750,
            };
          },
        },
        objectStore: {
          async put(object) {
            uploads += 1;
            return { mirrorUrl: `https://cdn.example.test/${object.key}` };
          },
        },
      });

      const first = await service.mirror(INPUT);
      assert.equal(first.status, "mirrored");
      assert.equal(uploads, 1);

      const secondService = new ImageMirrorService({
        repository: createMongoImageMirrorRepository(db),
        assertUrl: async (url) => new URL(url),
        fetcher: {
          async fetch() {
            throw new Error("must not fetch an already mirrored object");
          },
        },
        objectStore: {
          async put() {
            throw new Error("must not upload an already mirrored object");
          },
        },
      });
      const persisted = await secondService.mirror(INPUT);
      assert.equal(persisted.status, "mirrored");
      assert.equal(persisted.mirrorUrl, first.mirrorUrl);

      const invalidated = await secondService.invalidate(
        persisted.idempotencyKey,
        "上游图片撤回"
      );
      assert.equal(invalidated?.status, "invalidated");
      assert.equal(invalidated?.error?.message, "上游图片撤回");

      const raw = await db
        .collection(COLLECTIONS.IMAGE_MIRRORS)
        .findOne({ idempotency_key: persisted.idempotencyKey });
      assert.equal(raw?.content_id, INPUT.contentId);
      assert.equal(raw?.provider_id, INPUT.providerId);
      assert.equal(raw?.external_id, INPUT.externalId);
      assert.equal(raw?.original_url, INPUT.originalUrl);
      assert.equal(raw?.status, "invalidated");
      assert.equal(raw?.mirror_url, first.mirrorUrl);
    } finally {
      await client.db(databaseName).dropDatabase().catch(() => undefined);
      await client.close();
    }
  }
);

