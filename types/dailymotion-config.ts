export interface DailymotionChannelConfig {
  id: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
  isActive: boolean;
  createdAt: string;
}

export interface DailymotionConfigData {
  channels: DailymotionChannelConfig[];
  defaultChannelId?: string;
}
