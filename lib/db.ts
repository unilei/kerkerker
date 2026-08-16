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
}

// 获取 MongoClient 实例（用于事务操作）
export function getMongoClient(): MongoClient | undefined {
  return globalForMongo.mongoClient;
}

// 获取数据库实例
export async function getDatabase(): Promise<Db> {
  // 如果已有数据库实例，验证连接健康状态
  if (globalForMongo.mongoDb) {
    if (await isConnectionHealthy()) {
      return globalForMongo.mongoDb;
    }
    // 连接失效，清理并重连
    console.log('⚠️ MongoDB 连接失效，正在重新连接...');
    clearConnection();
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
    
    // 初始化数据库集合和索引（仅首次）
    await initializeDatabase(globalForMongo.mongoDb);
    
    console.log('✅ MongoDB 连接成功');
    return globalForMongo.mongoDb;
  } catch (error) {
    // 连接失败时清理状态，允许重试
    clearConnection();
    console.error('❌ MongoDB 连接失败:', error);
    throw error;
  }
}

// 初始化数据库集合和索引（仅首次执行）
async function initializeDatabase(db: Db) {
  // 跳过重复初始化
  if (globalForMongo.initialized) return;

  try {
    // 创建 pan_resources 集合的索引
    const panResourcesCollection = db.collection(COLLECTIONS.PAN_RESOURCES);
    await panResourcesCollection.createIndex({ douban_id: 1 });
    await panResourcesCollection.createIndex({ enabled: 1 });
    await panResourcesCollection.createIndex({ internal_id: 1 });
    await panResourcesCollection.createIndex({ kkpan_id: 1 });

    // 创建 pan_sync_state 集合的索引
    const panSyncStateCollection = db.collection(COLLECTIONS.PAN_SYNC_STATE);
    await panSyncStateCollection.createIndex({ id: 1 }, { unique: true });

    globalForMongo.initialized = true;
    console.log('✅ MongoDB 数据库初始化完成');
  } catch (error) {
    console.error('⚠️ 数据库初始化警告:', error);
    // 不抛出错误，因为索引可能已经存在
  }
}

// 关闭数据库连接
export async function closeDatabase() {
  if (globalForMongo.mongoClient) {
    await globalForMongo.mongoClient.close();
    clearConnection();
    console.log('✅ MongoDB 连接已关闭');
  }
}
