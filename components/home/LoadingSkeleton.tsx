export function LoadingSkeleton() {
  return (
    <div>
      {/* Hero 骨架屏 - 匹配实际页面的宽高比 */}
      <div className="relative w-full aspect-[3/4] md:aspect-[12/5] overflow-hidden bg-gradient-to-br from-zinc-950 via-black to-zinc-950">
        {/* 动画光效 */}
        <div className="absolute inset-0 overflow-hidden">
          <div className="absolute -inset-[100%] animate-[spin_3s_linear_infinite] bg-gradient-to-r from-transparent via-white/5 to-transparent" />
        </div>
        
        {/* 渐变遮罩 */}
        <div className="absolute inset-0 bg-gradient-to-t md:bg-gradient-to-r from-black/95 via-black/70 md:via-black/50 to-transparent" />
        <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-transparent to-transparent" />
        
        {/* 内容骨架 */}
        <div className="absolute inset-0 flex items-end">
          <div className="w-full px-4 md:px-12 pb-8 md:pb-12 lg:pb-16">
            <div className="max-w-3xl space-y-3 md:space-y-4">
              {/* 标题骨架 */}
              <div className="h-12 md:h-16 bg-zinc-900/50 rounded-lg w-3/4 animate-pulse" />
              
              {/* 评分和标签骨架 */}
              <div className="flex flex-wrap items-center gap-2">
                <div className="h-7 w-16 bg-zinc-900/50 rounded-full animate-pulse" />
                <div className="h-7 w-20 bg-zinc-900/50 rounded-full animate-pulse" />
                <div className="h-7 w-24 bg-zinc-900/50 rounded-full animate-pulse" />
                <div className="h-7 w-20 bg-zinc-900/50 rounded-full animate-pulse" />
              </div>
              
              {/* 描述骨架 - 仅PC端显示 */}
              <div className="hidden md:block space-y-2">
                <div className="h-5 bg-zinc-900/50 rounded w-full animate-pulse" />
                <div className="h-5 bg-zinc-900/50 rounded w-5/6 animate-pulse" />
              </div>
              
              {/* 按钮骨架 */}
              <div className="flex items-center gap-3 pt-1">
                <div className="h-12 md:h-14 w-36 md:w-40 bg-zinc-800/50 rounded-lg animate-pulse" />
              </div>
            </div>
          </div>
        </div>
        
        {/* 轮播指示器骨架 - 仅桌面端显示 */}
        <div className="absolute hidden md:flex bottom-6 left-1/2 -translate-x-1/2 items-center gap-2 z-20">
          {[...Array(5)].map((_, i) => (
            <div 
              key={i} 
              className={`${i === 0 ? 'w-8 h-2' : 'w-2 h-2'} bg-white/30 rounded-full animate-pulse`}
            />
          ))}
        </div>
      </div>

      {/* 分类骨架屏 - 10个分类，每个15个卡片 */}
      <div className="relative z-20 mt-6 sm:-mt-4 md:-mt-4 lg:-mt-4 space-y-10 md:space-y-12 lg:space-y-16 pb-16">
        {[...Array(10)].map((_, i) => (
          <div key={i} className="px-4 md:px-12">
            {/* 分类标题骨架 */}
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="w-5 h-5 md:w-6 md:h-6 bg-zinc-900/50 rounded animate-pulse" />
                <div className="h-7 md:h-8 bg-zinc-900/50 rounded-lg w-32 md:w-40 animate-pulse" />
              </div>
              {/* 查看全部按钮骨架 */}
              <div className="h-5 w-20 bg-zinc-900/30 rounded animate-pulse" />
            </div>
            
            {/* 影片卡片骨架 - 15个卡片 */}
            <div className="flex overflow-x-auto space-x-3 md:space-x-4 pb-4 scrollbar-hide">
              {[...Array(15)].map((_, j) => (
                <div key={j} className="flex-shrink-0 w-40 sm:w-48 md:w-56">
                  {/* 海报骨架 */}
                  <div className="relative aspect-[2/3] bg-gradient-to-br from-zinc-950 via-black to-zinc-950 rounded-lg overflow-hidden">
                    <div className="absolute inset-0 animate-pulse bg-gradient-to-tr from-transparent via-white/10 to-transparent" />
                  </div>
                  {/* 标题骨架 */}
                  <div className="h-5 md:h-6 bg-zinc-900/50 rounded w-3/4 mt-2 animate-pulse" />
                  {/* 评分骨架 */}
                  <div className="h-4 bg-zinc-900/30 rounded w-1/2 mt-1.5 animate-pulse" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
