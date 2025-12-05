interface EmptyStateProps {
  onRetry: () => void;
}

export function EmptyState({ onRetry }: EmptyStateProps) {
  return (
    <div className="h-screen flex items-center justify-center">
      <div className="text-center px-4 max-w-md">
        <div className="w-24 h-24 mx-auto mb-6 bg-gray-800 rounded-full flex items-center justify-center">
          <svg
            className="w-12 h-12 text-gray-500"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z"
            />
          </svg>
        </div>
        <h2 className="text-2xl font-bold text-white mb-2">暂无内容</h2>
        <p className="text-gray-400 mb-6 text-sm">当前没有可显示的内容</p>
        <button
          onClick={onRetry}
          className="px-6 py-3 bg-gray-700 hover:bg-gray-600 text-white rounded-lg font-medium transition-colors"
        >
          刷新
        </button>
      </div>
    </div>
  );
}
