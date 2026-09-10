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
    // 短剧库：归一化剧名键唯一去重（同一部剧跨 kkpan 行变化身份稳定）；
    // 前台按状态/时间查询。旧流水线时代的索引（enabled/tags/五态）清理掉。
    // 唯一索引必须 partial：迁移期库里还留着无 content_key 的旧 duanjugou
    // 文档，全量唯一索引会让它们全部等价于 (source, null) 而撞 E11000，
    // 应用启动建索引失败 → 整站 503（2026-09-10 部署实测踩坑）
    const shortDramasCollection = db.collection(COLLECTIONS.SHORT_DRAMAS);
    await shortDramasCollection.createIndex(
      { source: 1, content_key: 1 },
      { unique: true, partialFilterExpression: { content_key: { $exists: true } } }
    );
    await shortDramasCollection.createIndex({ title: 1 });
    // 前台列表主查询（首页/公开接口）：published 等值在前，前台排序
    // 键（publish_date, created_at, _id）全序在后，keyset 翻页同走此索引
    await shortDramasCollection.createIndex({
      status: 1,
      publish_date: -1,
      created_at: -1,
      _id: -1,
    });
    for (const legacyIndex of [
      "status_1_updated_at_-1",
      "tags_1_updated_at_-1",
      "enabled_1_updated_at_-1",
      "status_1_enabled_1_publish_date_-1_created_at_-1__id_-1",
      "source_1_source_article_id_1",
    ]) {
      await shortDramasCollection
        .dropIndex(legacyIndex)
        .catch(() => undefined);
    }

    // 短剧同步状态（单例）
    const shortDramaSyncStateCollection = db.collection(
      COLLECTIONS.SHORT_DRAMA_SYNC_STATE
    );
    await shortDramaSyncStateCollection.createIndex({ id: 1 }, { unique: true });

    // 网盘凭证：每平台一条默认凭证（部分索引：仅约束 is_default: true 的文档；
    // 注意 Mongo partialFilterExpression 不支持 $type 别名 "boolean"，用等值条件）
    const cloudCredentialsCollection = db.collection(
      COLLECTIONS.CLOUD_CREDENTIALS
    );
    await cloudCredentialsCollection.createIndex(
      { platform: 1, is_default: 1 },
      {
        unique: true,
        partialFilterExpression: { is_default: true },
      }
    );

    // 访客夸克凭证：扫码会话 ID 唯一（一个浏览器会话一条登录态）；
    // expires_at 建 TTL 索引（expireAfterSeconds:0 = 到点即删），与读时
    // 惰性清理互补，避免无人再访问的过期记录长期留存
    const userQuarkCredentialsCollection = db.collection(
      COLLECTIONS.USER_QUARK_CREDENTIALS
    );
    await userQuarkCredentialsCollection.createIndex(
      { session_id: 1 },
      { unique: true }
    );
    await userQuarkCredentialsCollection.createIndex(
      { expires_at: 1 },
      { expireAfterSeconds: 0 }
    );

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
