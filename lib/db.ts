import { MongoClient, Db } from 'mongodb';
import { COLLECTIONS } from './constants/db';

// MongoDB 连接池配置
const MONGO_OPTIONS = {
  maxPoolSize: 10,          // 最大连接数
  minPoolSize: 2,           // 最小连接数
  maxIdleTimeMS: 30000,     // 空闲连接超时 30s
  connectTimeoutMS: 10000,  // 连接超时 10s
  retryWrites: true,        // 启用写重试
  retryReads: true,         // 启用读重试
};

// 健康检查间隔（毫秒）
const HEALTH_CHECK_INTERVAL = 30000;

// 获取 MongoDB 连接 URI
function getMongoURI(): string {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI 环境变量未设置');
  }
  return uri;
}

// 使用 globalThis 缓存连接，确保在 Next.js 热重载和无服务器环境中正确复用
const globalForMongo = globalThis as unknown as {
  mongoClient: MongoClient | undefined;
  mongoDb: Db | undefined;
  mongoClientPromise: Promise<MongoClient> | undefined;
  initializationPromise: Promise<void> | undefined;
  lastHealthCheck: number;
  initialized: boolean;
};

// 初始化全局状态
if (globalForMongo.lastHealthCheck === undefined) {
  globalForMongo.lastHealthCheck = 0;
}
if (globalForMongo.initialized === undefined) {
  globalForMongo.initialized = false;
}

// 检查连接健康状态（带间隔优化）
async function isConnectionHealthy(): Promise<boolean> {
  // 30秒内跳过重复检查
  const now = Date.now();
  if (now - globalForMongo.lastHealthCheck < HEALTH_CHECK_INTERVAL) {
    return !!globalForMongo.mongoClient;
  }

  if (!globalForMongo.mongoClient) return false;
  try {
    await globalForMongo.mongoClient.db().admin().ping();
    globalForMongo.lastHealthCheck = now;
    return true;
  } catch {
    return false;
  }
}

// 清理失效连接
function clearConnection() {
  globalForMongo.mongoClientPromise = undefined;
  globalForMongo.mongoClient = undefined;
  globalForMongo.mongoDb = undefined;
  globalForMongo.lastHealthCheck = 0;
  globalForMongo.initialized = false;
  globalForMongo.initializationPromise = undefined;
}

async function closeAndClearConnection() {
  const client = globalForMongo.mongoClient;
  const clientPromise = globalForMongo.mongoClientPromise;
  clearConnection();
  if (client) {
    await client.close().catch(() => undefined);
  } else if (clientPromise) {
    const pendingClient = await clientPromise.catch(() => undefined);
    if (pendingClient) await pendingClient.close().catch(() => undefined);
  }
}

// 获取 MongoClient 实例（用于事务操作）
export function getMongoClient(): MongoClient | undefined {
  return globalForMongo.mongoClient;
}

async function ensureDatabaseInitialized(db: Db): Promise<void> {
  if (globalForMongo.initialized) return;
  if (!globalForMongo.initializationPromise) {
    globalForMongo.initializationPromise = initializeDatabase(db).finally(() => {
      globalForMongo.initializationPromise = undefined;
    });
  }
  await globalForMongo.initializationPromise;
}

// 获取数据库实例
export async function getDatabase(
  options: { skipInitialization?: boolean } = {}
): Promise<Db> {
  // 如果已有数据库实例，验证连接健康状态
  if (globalForMongo.mongoDb) {
    if (await isConnectionHealthy()) {
      try {
        if (!options.skipInitialization) {
          await ensureDatabaseInitialized(globalForMongo.mongoDb);
        }
        return globalForMongo.mongoDb;
      } catch (error) {
        await closeAndClearConnection();
        console.error('❌ MongoDB 初始化失败:', error);
        throw error;
      }
    }
    // 连接失效，清理并重连
    console.log('⚠️ MongoDB 连接失效，正在重新连接...');
    await closeAndClearConnection();
  }

  try {
    const uri = getMongoURI();
    const dbName = process.env.MONGODB_DB_NAME || 'kerkerker';
    
    // 如果没有 client promise，创建一个
    if (!globalForMongo.mongoClientPromise) {
      const client = new MongoClient(uri, MONGO_OPTIONS);
      globalForMongo.mongoClientPromise = client.connect();
    }
    
    // 等待连接完成
    globalForMongo.mongoClient = await globalForMongo.mongoClientPromise;
    globalForMongo.mongoDb = globalForMongo.mongoClient.db(dbName);
    
    // 初始化数据库集合和索引（仅首次）。用 promise 锁避免同一进程并发初始化。
    if (!options.skipInitialization) {
      await ensureDatabaseInitialized(globalForMongo.mongoDb);
    }
    
    console.log('✅ MongoDB 连接成功');
    return globalForMongo.mongoDb;
  } catch (error) {
    // 连接失败时清理状态，允许重试
    await closeAndClearConnection();
    console.error('❌ MongoDB 连接失败:', error);
    throw error;
  }
}

// 初始化数据库集合和索引（仅首次执行）
async function initializeDatabase(db: Db) {
  // 跳过重复初始化
  if (globalForMongo.initialized) return;

  try {
    // 宿主内容身份：content_id 与每个 provider/external ID 组合都必须唯一。
    const contentIdentitiesCollection = db.collection(COLLECTIONS.CONTENT_IDENTITIES);
    await contentIdentitiesCollection.createIndex({ content_id: 1 }, { unique: true });
    await contentIdentitiesCollection.createIndex(
      { "external_refs.provider_id": 1, "external_refs.external_id": 1 },
      { unique: true }
    );
    await contentIdentitiesCollection.createIndex({ updated_at: -1 });

    // 创建 pan_resources 集合的索引
    const panResourcesCollection = db.collection(COLLECTIONS.PAN_RESOURCES);
    await panResourcesCollection.createIndex({ douban_id: 1 });
    await panResourcesCollection.createIndex({ content_id: 1 });
    await panResourcesCollection.createIndex(
      { provider_id: 1, provider_resource_id: 1 },
      {
        unique: true,
        partialFilterExpression: {
          provider_id: { $type: "string" },
          provider_resource_id: { $type: "string" },
        },
      }
    );
    await panResourcesCollection.createIndex({ enabled: 1 });
    await panResourcesCollection.createIndex({ internal_id: 1 });
    // kkpan_id 部分唯一索引：同一 kkpan 资源在库里只能有一条，避免并发同步重复写入。
    // 仅对 kkpan_id 字段类型为 number 的文档生效 —— 手工录入资源此字段不写入文档
    // （createPanResourceInDB 在 input.kkpan_id 为 undefined 时省略该键），所以不受约束。
    //
    // 运行时只做幂等检查，绝不 drop 已有索引。旧普通索引或历史重复数据必须先
    // 执行一次性维护脚本，否则直接失败并让调用方重试，避免在无唯一约束窗口中写入重复数据。
    const indexes = await panResourcesCollection.listIndexes().toArray();
    const kkpanIndexes = indexes.filter((index) => {
      const keys = Object.keys(index.key || {});
      return keys.length === 1 && keys[0] === "kkpan_id";
    });
    const isDesiredKkpanIndex = (index: (typeof indexes)[number]) => {
      const key = index.key as Record<string, unknown>;
      const partial = index.partialFilterExpression as
        | Record<string, unknown>
        | undefined;
      const condition = partial?.kkpan_id;
      return (
        index.unique === true &&
        key.kkpan_id === 1 &&
        partial != null &&
        Object.keys(partial).length === 1 &&
        condition != null &&
        typeof condition === "object" &&
        !Array.isArray(condition) &&
        Object.keys(condition as Record<string, unknown>).length === 1 &&
        (condition as Record<string, unknown>).$type === "number"
      );
    };
    const hasDesiredKkpanIndex = kkpanIndexes.some(isDesiredKkpanIndex);
    const hasWrongKkpanIndex = kkpanIndexes.some(
      (index) => !isDesiredKkpanIndex(index)
    );

    if (hasWrongKkpanIndex) {
      throw new Error(
        'pan_resources.kkpan_id 索引不是期望的部分唯一索引，请先运行 npx tsx scripts/pan-dedup.ts'
      );
    }
    if (!hasDesiredKkpanIndex) {
      if (kkpanIndexes.length > 0) {
        throw new Error(
          'pan_resources.kkpan_id 索引不是期望的部分唯一索引，请先运行 npx tsx scripts/pan-dedup.ts'
        );
      }
      await panResourcesCollection.createIndex(
        { kkpan_id: 1 },
        {
          unique: true,
          // 只对 number 类型的 kkpan_id 建唯一约束；手工资源字段缺失不参与
          partialFilterExpression: { kkpan_id: { $type: "number" } },
        }
      );
    }

    // 创建 pan_sync_state 集合的索引
    const panSyncStateCollection = db.collection(COLLECTIONS.PAN_SYNC_STATE);
    await panSyncStateCollection.createIndex({ id: 1 }, { unique: true });

    // 影片级网盘同步台账：按豆瓣 ID 幂等，状态查询和待处理任务取数有独立索引。
    const panSyncTargetsCollection = db.collection(COLLECTIONS.PAN_SYNC_TARGETS);
    await panSyncTargetsCollection.createIndex(
      { douban_id: 1 },
      { unique: true }
    );
    await panSyncTargetsCollection.createIndex({ content_id: 1 });
    await panSyncTargetsCollection.createIndex({ status: 1, updated_at: -1 });
    await panSyncTargetsCollection.createIndex({ next_attempt_at: 1 });

    // 应用内影片同步调度器：两类任务各有独立配置，运行记录和事件按时间查询。
    const panSyncScheduleCollection = db.collection(
      COLLECTIONS.PAN_SYNC_SCHEDULE
    );
    await panSyncScheduleCollection.createIndex({ task: 1 }, { unique: true });

    const panSyncRunsCollection = db.collection(COLLECTIONS.PAN_SYNC_RUNS);
    await panSyncRunsCollection.createIndex({ run_id: 1 }, { unique: true });
    await panSyncRunsCollection.createIndex(
      { task: 1, schedule_slot: 1 },
      {
        unique: true,
        partialFilterExpression: { schedule_slot: { $type: "string" } },
      }
    );
    await panSyncRunsCollection.createIndex({ task: 1, created_at: -1 });
    await panSyncRunsCollection.createIndex({ status: 1, updated_at: -1 });
    await panSyncRunsCollection.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });

    const panSyncRunEventsCollection = db.collection(
      COLLECTIONS.PAN_SYNC_RUN_EVENTS
    );
    await panSyncRunEventsCollection.createIndex(
      { run_id: 1, seq: 1 },
      { unique: true }
    );
    await panSyncRunEventsCollection.createIndex({ run_id: 1, created_at: 1 });
    await panSyncRunEventsCollection.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });

    globalForMongo.initialized = true;
    console.log('✅ MongoDB 数据库初始化完成');
  } catch (error) {
    console.error('⚠️ 数据库初始化失败:', error);
    throw error;
  }
}

// 关闭数据库连接
export async function closeDatabase() {
  if (globalForMongo.mongoClient || globalForMongo.mongoClientPromise) {
    await closeAndClearConnection();
    console.log('✅ MongoDB 连接已关闭');
  }
}
