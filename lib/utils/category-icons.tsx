// 分类图标工具函数
import { Film, Tv, Drama, Clapperboard, Palette, BookOpen } from "lucide-react";
import type { ReactElement } from "react";

/**
 * 根据分类名称获取对应的图标
 */
export function getCategoryIcon(name: string): ReactElement {
  const iconClass = "w-5 h-5";
  
  switch (name) {
    case "豆瓣热映":
      return <Film className={iconClass} />;
    case "热门电视":
      return <Tv className={iconClass} />;
    case "国产剧":
      return <Drama className={iconClass} />;
    case "综艺":
      return <Clapperboard className={iconClass} />;
    case "美剧":
      return <Tv className={iconClass} />;
    case "日剧":
      return <Drama className={iconClass} />;
    case "韩剧":
      return <Drama className={iconClass} />;
    case "日本动画":
      return <Palette className={iconClass} />;
    case "纪录片":
      return <BookOpen className={iconClass} />;
    default:
      return <Film className={iconClass} />;
  }
}

/**
 * 根据分类名称获取分类页面的路径
 */
export function getCategoryPath(name: string): string {
  const pathMap: Record<string, string> = {
    豆瓣热映: "in_theaters",
    热门电视: "hot_tv",
    国产剧: "chinese_tv",
    综艺: "variety",
    美剧: "us_tv",
    日剧: "jp_tv",
    韩剧: "kr_tv",
    日本动画: "anime",
    纪录片: "documentary",
  };
  return pathMap[name] || "hot_movies";
}
