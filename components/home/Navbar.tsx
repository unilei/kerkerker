import Link from "next/link";
import { useRouter } from "next/navigation";

interface NavbarProps {
  scrolled: boolean;
  onSearchOpen: () => void;
}

export function Navbar({ scrolled, onSearchOpen }: NavbarProps) {
  const router = useRouter();

  return (
    <nav
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
        scrolled
          ? "bg-black"
          : "bg-gradient-to-b from-black/80 to-transparent"
      }`}
    >
      <div className="px-4 md:px-12 py-4 flex items-center justify-between">
        {/* Logo */}
        <div className="flex items-center space-x-8">
          <div className="flex items-center gap-1">
            <img className="w-10 h-10" src="/logo.png" alt="logo" />
            <h1
              onClick={() => router.push("/")}
              className="text-red-600 text-2xl md:text-3xl font-bold tracking-tight cursor-pointer hover:text-red-500 transition-colors"
            >
              壳儿
            </h1>
          </div>
          {/* 导航链接 - 桌面端 */}
          <div className="hidden sm:flex items-center space-x-6">
            <Link
              href="/"
              className="text-white hover:text-gray-300 transition-colors text-sm font-medium"
            >
              首页
            </Link>
            <Link
              href="/movies"
              className="text-gray-400 hover:text-gray-300 transition-colors text-sm"
            >
              电影
            </Link>
            <Link
              href="/tv"
              className="text-gray-400 hover:text-gray-300 transition-colors text-sm"
            >
              电视剧
            </Link>
            <Link
              href="/latest"
              className="text-gray-400 hover:text-gray-300 transition-colors text-sm"
            >
              最新
            </Link>
            <Link
              href="/dailymotion"
              className="text-gray-400 hover:text-gray-300 transition-colors text-sm"
            >
              短剧Motion
            </Link>
            <Link
              href="https://github.com/unilei/kerkerker"
              target="_blank"
              className="text-gray-400 hover:text-gray-300 transition-colors text-sm"
            >
              Github
            </Link>
          </div>
        </div>

        {/* 右侧功能区 */}
        <div className="flex items-center space-x-4">
          {/* 搜索按钮 */}
          <button
            onClick={onSearchOpen}
            className="p-2 hover:bg-white/10 rounded-full transition-colors"
            title="搜索"
          >
            <svg
              className="w-6 h-6"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
          </button>
        </div>
      </div>
    </nav>
  );
}
