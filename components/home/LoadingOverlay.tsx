export function LoadingOverlay() {
  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center">
      <div className="text-center">
        <div className="animate-spin rounded-full h-16 w-16 border-4 border-gray-700 border-t-red-600 mx-auto mb-4" />
        <p className="text-white text-lg font-medium">正在为你寻找播放源</p>
        <p className="text-gray-400 text-sm mt-2">搜索中，请稍候...</p>
      </div>
    </div>
  );
}
