// 首页相关类型定义
import type { DoubanMovie } from "./douban";

export interface NewApiMovie {
  id: string;
  title: string;
  rate: string;
  cover: string;
  url: string;
  [key: string]: unknown;
}

export interface CategoryData {
  name: string;
  data: NewApiMovie[];
}

export interface HeroData {
  poster_horizontal: string;
  poster_vertical: string;
  description?: string;
  genres?: string[];
}

// HeroMovie 就是 DoubanMovie 类型
export type HeroMovie = DoubanMovie;
