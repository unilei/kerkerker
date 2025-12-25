import { getDatabase } from './db';
import { createCache } from './cache';
import type { DailymotionConfigData, DailymotionChannelConfig } from '@/types/dailymotion-config';

// 缓存键
const CACHE_KEY_CONFIG = 'dailymotion:config';
const CACHE_KEY_DEFAULT_CHANNEL = 'dailymotion:default_channel';
const CACHE_TTL = 3600; // 1小时

// 创建缓存实例
const cache = createCache(CACHE_TTL);

export interface DailymotionChannelDoc {
  _id?: string;
  id: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DailymotionConfigDoc {
  _id?: string;
  id: number; // 固定为 1，单例配置
  defaultChannelId?: string;
  updatedAt: string;
}

// 将数据库文档转换为配置对象
function docsToConfig(
  channels: DailymotionChannelDoc[],
  configDoc: DailymotionConfigDoc | null
): DailymotionConfigData {
  return {
    channels: channels.map((doc) => ({
      id: doc.id,
      username: doc.username,
      displayName: doc.displayName,
      avatarUrl: doc.avatarUrl,
      isActive: doc.isActive,
      createdAt: doc.createdAt,
    })),
    defaultChannelId: configDoc?.defaultChannelId,
  };
}

// 获取所有频道配置（带缓存）
export async function getDailymotionConfigFromDB(): Promise<DailymotionConfigData> {
  // 尝试从缓存获取
  const cached = await cache.get<DailymotionConfigData>(CACHE_KEY_CONFIG);
  if (cached) {
    console.log('✅ 从缓存获取 Dailymotion 配置');
    return cached;
  }

  // 从数据库获取
  const db = await getDatabase();
  const channelsCollection = db.collection<DailymotionChannelDoc>('dailymotion_channels');
  const configCollection = db.collection<DailymotionConfigDoc>('dailymotion_config');

  // 获取所有频道
  const channels = await channelsCollection.find().sort({ createdAt: 1 }).toArray();

  // 获取配置
  const configDoc = await configCollection.findOne({ id: 1 });

  // 如果没有任何频道，返回默认配置
  if (channels.length === 0) {
    const defaultConfig: DailymotionConfigData = {
      channels: [
        {
          id: 'default',
          username: 'kchow125',
          displayName: 'KChow125',
          isActive: true,
          createdAt: new Date().toISOString(),
        },
      ],
      defaultChannelId: 'default',
    };

    // 保存默认配置到数据库
    await saveDailymotionConfigToDB(defaultConfig);

    return defaultConfig;
  }

  const config = docsToConfig(channels, configDoc);

  // 缓存结果
  await cache.set(CACHE_KEY_CONFIG, config);

  console.log('✅ 从数据库获取 Dailymotion 配置');
  return config;
}

// 保存完整配置到数据库
export async function saveDailymotionConfigToDB(config: DailymotionConfigData): Promise<void> {
  const db = await getDatabase();
  const channelsCollection = db.collection<DailymotionChannelDoc>('dailymotion_channels');
  const configCollection = db.collection<DailymotionConfigDoc>('dailymotion_config');
  const now = new Date().toISOString();

  // 删除所有现有频道
  await channelsCollection.deleteMany({});

  // 插入新频道
  if (config.channels.length > 0) {
    const channelDocs: DailymotionChannelDoc[] = config.channels.map((channel) => ({
      id: channel.id,
      username: channel.username,
      displayName: channel.displayName,
      avatarUrl: channel.avatarUrl,
      isActive: channel.isActive,
      createdAt: channel.createdAt,
      updatedAt: now,
    }));

    await channelsCollection.insertMany(channelDocs);
  }

  // 更新配置文档
  await configCollection.updateOne(
    { id: 1 },
    {
      $set: {
        id: 1,
        defaultChannelId: config.defaultChannelId,
        updatedAt: now,
      },
    },
    { upsert: true }
  );

  // 清除缓存
  await cache.del(CACHE_KEY_CONFIG);
  await cache.del(CACHE_KEY_DEFAULT_CHANNEL);

  console.log('✅ Dailymotion 配置已保存到数据库');
}

// 添加频道
export async function addDailymotionChannelToDB(
  username: string,
  displayName: string,
  avatarUrl?: string
): Promise<DailymotionChannelConfig> {
  const db = await getDatabase();
  const channelsCollection = db.collection<DailymotionChannelDoc>('dailymotion_channels');
  const configCollection = db.collection<DailymotionConfigDoc>('dailymotion_config');
  const now = new Date().toISOString();

  const newChannel: DailymotionChannelDoc = {
    id: `channel_${Date.now()}`,
    username,
    displayName,
    avatarUrl,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  };

  await channelsCollection.insertOne(newChannel);

  // 如果是第一个频道，设置为默认
  const count = await channelsCollection.countDocuments();
  if (count === 1) {
    await configCollection.updateOne(
      { id: 1 },
      {
        $set: {
          id: 1,
          defaultChannelId: newChannel.id,
          updatedAt: now,
        },
      },
      { upsert: true }
    );
  }

  // 清除缓存
  await cache.del(CACHE_KEY_CONFIG);

  console.log(`✅ 添加 Dailymotion 频道: ${displayName}`);

  return {
    id: newChannel.id,
    username: newChannel.username,
    displayName: newChannel.displayName,
    avatarUrl: newChannel.avatarUrl,
    isActive: newChannel.isActive,
    createdAt: newChannel.createdAt,
  };
}

// 更新频道
export async function updateDailymotionChannelInDB(
  id: string,
  updates: Partial<Omit<DailymotionChannelConfig, 'id' | 'createdAt'>>
): Promise<void> {
  const db = await getDatabase();
  const collection = db.collection<DailymotionChannelDoc>('dailymotion_channels');
  const now = new Date().toISOString();

  await collection.updateOne(
    { id },
    {
      $set: {
        ...updates,
        updatedAt: now,
      },
    }
  );

  // 清除缓存
  await cache.del(CACHE_KEY_CONFIG);

  console.log(`✅ 更新 Dailymotion 频道: ${id}`);
}

// 删除频道
export async function deleteDailymotionChannelFromDB(id: string): Promise<void> {
  const db = await getDatabase();
  const channelsCollection = db.collection<DailymotionChannelDoc>('dailymotion_channels');
  const configCollection = db.collection<DailymotionConfigDoc>('dailymotion_config');

  await channelsCollection.deleteOne({ id });

  // 如果删除的是默认频道，选择第一个作为新的默认频道
  const config = await configCollection.findOne({ id: 1 });
  if (config?.defaultChannelId === id) {
    const firstChannel = await channelsCollection.findOne({}, { sort: { createdAt: 1 } });
    if (firstChannel) {
      await configCollection.updateOne(
        { id: 1 },
        {
          $set: {
            defaultChannelId: firstChannel.id,
            updatedAt: new Date().toISOString(),
          },
        }
      );
    }
  }

  // 清除缓存
  await cache.del(CACHE_KEY_CONFIG);
  await cache.del(CACHE_KEY_DEFAULT_CHANNEL);

  console.log(`✅ 删除 Dailymotion 频道: ${id}`);
}

// 设置默认频道
export async function setDefaultDailymotionChannelInDB(channelId: string): Promise<void> {
  const db = await getDatabase();
  const collection = db.collection<DailymotionConfigDoc>('dailymotion_config');
  const now = new Date().toISOString();

  await collection.updateOne(
    { id: 1 },
    {
      $set: {
        id: 1,
        defaultChannelId: channelId,
        updatedAt: now,
      },
    },
    { upsert: true }
  );

  // 清除缓存
  await cache.del(CACHE_KEY_CONFIG);
  await cache.del(CACHE_KEY_DEFAULT_CHANNEL);

  console.log(`✅ 设置默认 Dailymotion 频道: ${channelId}`);
}

// 清除所有 Dailymotion 相关缓存
export async function clearDailymotionCache(): Promise<void> {
  await cache.delPattern('dailymotion:*');
  console.log('✅ 清除所有 Dailymotion 缓存');
}
