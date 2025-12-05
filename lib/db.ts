import { MongoClient, Db } from 'mongodb';

// MongoDB 连接
let client: MongoClient | null = null;
let db: Db | null = null;

// 获取 MongoDB 连接 URI
function getMongoURI(): string {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI 环境变量未设置');
  }
  return uri;
}

// 获取数据库实例
export async function getDatabase(): Promise<Db> {
  if (db) {
    return db;
  }

  try {
    const uri = getMongoURI();
    client = new MongoClient(uri);
    await client.connect();
    
    // 从 URI 中提取数据库名，或使用默认名称
    const dbName = process.env.MONGODB_DB_NAME || 'kerkerker';
    db = client.db(dbName);
    
    // 初始化数据库集合和索引
    await initializeDatabase(db);
    
    console.log('✅ MongoDB 连接成功');
    return db;
  } catch (error) {
    console.error('❌ MongoDB 连接失败:', error);
    throw error;
  }
}

// 初始化数据库集合和索引
async function initializeDatabase(db: Db) {
  try {
    // 创建 vod_sources 集合的索引
    const vodSourcesCollection = db.collection('vod_sources');
    await vodSourcesCollection.createIndex({ key: 1 }, { unique: true });
    await vodSourcesCollection.createIndex({ enabled: 1 });
    await vodSourcesCollection.createIndex({ sort_order: 1 });

    // 创建 vod_source_selection 集合的索引
    const selectionCollection = db.collection('vod_source_selection');
    await selectionCollection.createIndex({ id: 1 }, { unique: true });

    // 创建 dailymotion_channels 集合的索引
    const dailymotionChannelsCollection = db.collection('dailymotion_channels');
    await dailymotionChannelsCollection.createIndex({ id: 1 }, { unique: true });
    await dailymotionChannelsCollection.createIndex({ username: 1 });
    await dailymotionChannelsCollection.createIndex({ isActive: 1 });

    // 创建 dailymotion_config 集合的索引
    const dailymotionConfigCollection = db.collection('dailymotion_config');
    await dailymotionConfigCollection.createIndex({ id: 1 }, { unique: true });

    console.log('✅ MongoDB 数据库初始化完成');
  } catch (error) {
    console.error('⚠️ 数据库初始化警告:', error);
    // 不抛出错误，因为索引可能已经存在
  }
}

// 关闭数据库连接
export async function closeDatabase() {
  if (client) {
    await client.close();
    client = null;
    db = null;
    console.log('✅ MongoDB 连接已关闭');
  }
}
