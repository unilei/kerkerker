/**
 * 海报墙加载骨架:与首页网格布局一致(8 张 2:3 海报卡),
 * 刻意保持轻量——大体积动画骨架会在水合期阻塞 React 挂载。
 */
export function LoadingSkeleton() {
  return (
    <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-3 md:gap-4">
      {[...Array(8)].map((_, i) => (
        <div key={i} className="flex-shrink-0">
          {/* 海报骨架 */}
          <div className="relative aspect-[2/3] bg-zinc-900/50 rounded-lg overflow-hidden">
            <div className="absolute inset-0 animate-pulse bg-gradient-to-tr from-transparent via-white/10 to-transparent" />
          </div>
          {/* 标题骨架 */}
          <div className="h-4 md:h-5 bg-zinc-900/50 rounded w-3/4 mt-2 animate-pulse" />
        </div>
      ))}
    </div>
  );
}
