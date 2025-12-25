export interface DailymotionVideo {
  id: string;
  title: string;
  thumbnail: string;
  duration: string;
  url: string;
  created_time?: string;
  views_total?: number;
}

export interface DailymotionChannel {
  name: string;
  handle: string;
  avatar: string;
  videos: DailymotionVideo[];
  hasMore?: boolean;
  total?: number;
  page?: number;
}
