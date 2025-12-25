// 播放器配置管理API
import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/db';

export interface PlayerConfig {
  mode: 'iframe' | 'local' | 'auto'; // 播放器模式
  enableProxy: boolean; // 是否启用代理
  iframePlayers: IframePlayer[]; // iframe播放器列表
  localPlayerSettings: LocalPlayerSettings; // 本地播放器设置
}

export interface IframePlayer {
  id: string;
  name: string;
  url: string;
  priority: number;
  timeout: number;
  enabled: boolean;
}

export interface LocalPlayerSettings {
  autoSaveProgress: boolean; // 自动保存进度
  progressSaveInterval: number; // 进度保存间隔（秒）
  theme: string; // 主题颜色
}

// MongoDB文档类型（包含_id字段）
interface PlayerConfigDocument extends PlayerConfig {
  _id: string;
}

// 默认配置
const DEFAULT_CONFIG: PlayerConfig = {
  mode: 'local', // 默认使用本地代理模式
  enableProxy: true,
  iframePlayers: [
    {
      id: 'player1',
      name: 'M1907解析接口',
      url: 'https://im1907.top/?jx=',
      priority: 1,
      timeout: 10000,
      enabled: true,
    },
    {
      id: 'player2',
      name: '虾米解析接口',
      url: 'https://jx.xmflv.com/?url=',
      priority: 2,
      timeout: 10000,
      enabled: true,
    },
    {
      id: 'player3',
      name: '咸鱼解析接口',
      url: 'https://jx.xymp4.cc/?url=',
      priority: 3,
      timeout: 10000,
      enabled: true,
    },
    {
      id: 'player4',
      name: '极速解析接口',
      url: 'https://jx.2s0cn/player/?url=',
      priority: 4,
      timeout: 12000,
      enabled: true,
    },
    {
      id: 'player5',
      name: 'PlayerJY解析接口',
      url: 'https://jx.playerjy.com/?url=',
      priority: 5,
      timeout: 12000,
      enabled: true,
    },
    {
      id: 'player6',
      name: '备用播放器',
      url: 'https://jx.jsonplayer.com/player/?url=',
      priority: 6,
      timeout: 12000,
      enabled: true,
    },
    {
      id: 'player7',
      name: '备用播放器2',
      url: 'https://jx.m3u8.tv/jiexi/?url=',
      priority: 7,
      timeout: 15000,
      enabled: true,
    },
  ],
  localPlayerSettings: {
    autoSaveProgress: true,
    progressSaveInterval: 5,
    theme: '#ef4444',
  },
};

// 获取配置
export async function GET() {
  try {
    const db = await getDatabase();
    const configCollection = db.collection<PlayerConfigDocument>('player_config');

    // 从数据库获取配置
    const configDoc = await configCollection.findOne({ _id: 'player_config' });

    // 如果数据库中没有配置，返回默认配置并保存
    if (!configDoc) {
      const newDoc: PlayerConfigDocument = {
        _id: 'player_config',
        ...DEFAULT_CONFIG,
      };
      await configCollection.insertOne(newDoc);
      return NextResponse.json({
        code: 200,
        data: DEFAULT_CONFIG,
        msg: '获取配置成功（使用默认配置）',
      });
    }

    // 构造返回对象（排除_id字段）
    const config: PlayerConfig = {
      mode: configDoc.mode,
      enableProxy: configDoc.enableProxy,
      iframePlayers: configDoc.iframePlayers,
      localPlayerSettings: configDoc.localPlayerSettings,
    };

    return NextResponse.json({
      code: 200,
      data: config,
      msg: '获取配置成功',
    });
  } catch (error) {
    console.error('获取播放器配置失败:', error);
    return NextResponse.json(
      {
        code: 500,
        msg: '获取配置失败',
      },
      { status: 500 }
    );
  }
}

// 更新配置
export async function POST(request: NextRequest) {
  try {
    const config: Partial<PlayerConfig> = await request.json();

    // 验证配置格式
    if (!validateConfig(config)) {
      return NextResponse.json(
        {
          code: 400,
          msg: '配置格式错误',
        },
        { status: 400 }
      );
    }

    const db = await getDatabase();
    const configCollection = db.collection<PlayerConfigDocument>('player_config');

    // 获取现有配置
    const existingConfigDoc = await configCollection.findOne({ _id: 'player_config' });

    // 从文档中提取配置（排除_id）
    let existingConfig: PlayerConfig | null = null;
    if (existingConfigDoc) {
      existingConfig = {
        mode: existingConfigDoc.mode,
        enableProxy: existingConfigDoc.enableProxy,
        iframePlayers: existingConfigDoc.iframePlayers,
        localPlayerSettings: existingConfigDoc.localPlayerSettings,
      };
    }

    // 合并配置
    const mergedConfig: PlayerConfig = {
      ...DEFAULT_CONFIG,
      ...existingConfig,
      ...config,
    };

    // 保存到数据库（包含_id）
    const docToSave: PlayerConfigDocument = {
      _id: 'player_config',
      ...mergedConfig,
    };

    await configCollection.updateOne(
      { _id: 'player_config' },
      { $set: docToSave },
      { upsert: true }
    );

    return NextResponse.json({
      code: 200,
      data: mergedConfig,
      msg: '配置更新成功',
    });
  } catch (error) {
    console.error('更新播放器配置失败:', error);
    return NextResponse.json(
      {
        code: 500,
        msg: '配置更新失败',
      },
      { status: 500 }
    );
  }
}

function validateConfig(config: Partial<PlayerConfig>): boolean {
  // 验证模式
  if (config.mode && !['iframe', 'local', 'auto'].includes(config.mode)) {
    return false;
  }

  // 验证播放器列表
  if (config.iframePlayers) {
    for (const player of config.iframePlayers) {
      if (!player.id || !player.name || !player.url) {
        return false;
      }
    }
  }

  return true;
}
