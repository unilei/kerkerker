export function LoadingSkeleton() {
  return (
    <div className="min-h-screen bg-black">
      <style jsx>{`
        @keyframes shimmer {
          0% {
            background-position: -1000px 0;
          }
          100% {
            background-position: 1000px 0;
          }
        }
        .shimmer {
          background: linear-gradient(90deg, #171717 0%, #262626 50%, #171717 100%);
          background-size: 1000px 100%;
          animation: shimmer 1.5s infinite;
        }
      `}</style>
      <div className="px-3 md:px-6 lg:px-10 py-4">
        <div className="h-6 bg-neutral-900 rounded w-24 mb-4 px-1 shimmer" />
        {/* Video Grid Skeleton */}
        <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-6 2xl:grid-cols-10 gap-3 md:gap-4">
          {Array.from({ length: 30 }).map((_, i) => (
            <div key={i}>
              <div className="relative aspect-2/3 bg-neutral-900 rounded-xl shimmer overflow-hidden">
                {/* Simulating bottom overlay */}
                <div className="absolute bottom-0 left-0 right-0 p-3 space-y-1.5 bg-linear-to-t from-neutral-950 to-transparent">
                  <div className="h-4 bg-neutral-800 rounded shimmer" />
                  <div className="h-3 bg-neutral-800 rounded w-2/3 shimmer" />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

    </div>
  );
}
