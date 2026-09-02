import Link from "next/link";

/** 全局 404：详情页 notFound() 与任意未匹配路由都会落到这里（真 404 状态码） */
export default function NotFound() {
  return (
    <div className="min-h-screen bg-black flex items-center justify-center px-4">
      <div className="text-center max-w-md">
        <p className="text-6xl font-bold text-red-600 mb-4">404</p>
        <h1 className="text-xl font-bold text-white mb-2">页面不存在或资源尚未就绪</h1>
        <p className="text-gray-400 text-sm mb-8">
          你访问的短剧可能已被下架，或链接有误。回首页看看最新的短剧吧。
        </p>
        <Link
          href="/"
          className="inline-block px-6 py-3 bg-red-600 hover:bg-red-700 text-white rounded-full text-sm font-medium transition-colors"
        >
          回到首页
        </Link>
      </div>
    </div>
  );
}
