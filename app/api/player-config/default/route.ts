// 获取默认播放器配置API
import { NextResponse } from 'next/server';
import type { PlayerConfig } from '../route';

// 默认配置
const DEFAULT_CONFIG: PlayerConfig = {
  mode: 'iframe',
  enableProxy: false,
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

export async function GET() {
  return NextResponse.json({
    code: 200,
    data: DEFAULT_CONFIG,
    msg: '获取默认配置成功',
  });
}
