/**
 * 播放器加载状态组件
 */

export function PlayerLoading() {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black z-150 pointer-events-none">
      <div className="text-center">
        <div className="animate-spin rounded-full h-16 w-16 border-4 border-gray-700 border-t-red-600 mx-auto mb-4" />
        <p className="text-white text-lg">加载中...</p>
      </div>
    </div>
  );
}
