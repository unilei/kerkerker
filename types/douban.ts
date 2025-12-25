// 豆瓣影视数据类型定义

export interface DoubanMovie {
  cover: string;
  cover_x: number;
  cover_y: number;
  episode_info: string;
  id: string; // 豆瓣ID
  is_new: boolean;
  playable: boolean;
  rate: string;
  title: string;
  url: string;
}

export interface DoubanSection {
  title: string;
  type: 'hot' | 'top' | 'tv' | 'movie';
  subjects: DoubanMovie[];
}

export interface DoubanApiResponse {
  count: number;
  start: number;
  total: number;
  subjects: DoubanMovie[];
  title: string;
}
