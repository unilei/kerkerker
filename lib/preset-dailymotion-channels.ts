import type { DailymotionChannelConfig } from '@/types/dailymotion-config';

// 可导入的预设 Dailymotion 频道配置（纯数据，客户端安全）
export const presetDailymotionChannels: Omit<DailymotionChannelConfig, 'id' | 'createdAt'>[] = [
  {
    username: 'kchow125',
    displayName: 'KChow125',
    isActive: true,
  },
  {
    username: 'huinan520-349',
    displayName: '短剧全合集',
    avatarUrl: '',
    isActive: true,
  },
  {
    username: 'douyinduanju',
    displayName: '宠爱短剧',
    avatarUrl: '',
    isActive: true,
  },
  {
    username: 'HIGEGE',
    displayName: 'HIGEGE',
    avatarUrl: '',
    isActive: true,
  },
  {
    username: 'dm_9ea4e8672798025a29d1d2812d',
    displayName: '七月短剧天下',
    avatarUrl: '',
    isActive: true,
  },
];
