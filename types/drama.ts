export interface Drama {
  id: string | number;
  name: string;
  subName?: string;
  pic: string;
  remarks?: string;
  note?: string;
  type?: string;
  time?: string;
  playFrom?: string;
  actor?: string;
  director?: string;
  area?: string;
  year?: string;
  score?: string;
  total?: number;
  blurb?: string;
  tags?: string[];
  vod_class?: string;
}

export interface Episode {
  name: string;
  url: string;
}

export interface DramaDetail extends Drama {
  episodes: Episode[];
}

export interface Category {
  id: string | number;
  name: string;
  icon?: string;
  count?: number;
  children?: Category[];
}

export interface VodSource {
  key: string;
  name: string;
  api: string;
  playUrl?: string;      // 播放地址前缀
  usePlayUrl?: boolean;  // 是否使用播放地址（默认 true，如果有 playUrl）
  priority?: number;     // 优先级，数值越小优先级越高（默认 0）
  type: 'json';          // 仅支持 JSON 格式
  searchProxy?: string;  // 搜索代理 URL，使用 POST 请求
  parseProxy?: string;   // 视频解析代理 URL
  parseToken?: string;   // 视频解析 token
  parseId?: string;      // 视频解析 id 参数
}

export interface ApiResponse<T = unknown> {
  code: number;
  msg: string;
  data?: T;
}

export interface DramaListData {
  list: Drama[];
  page: number;
  pagecount: number;
  limit: number;
  total: number;
}
