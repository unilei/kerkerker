import { permanentRedirect } from "next/navigation";

/**
 * /all 短链入口：固定 301 到第 1 页，保证分页路由 /all/page/[page]
 * 是唯一的可索引列表 URL 形态。
 */
export default function AllIndexPage() {
  permanentRedirect("/all/page/1");
}
