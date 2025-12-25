import { X, AlertCircle, Eye, Clock, Play } from 'lucide-react';
import type { DailymotionVideo } from '@/types/dailymotion';

interface VideoPlayerModalProps {
  video: DailymotionVideo | null;
  videoError: boolean;
  onClose: () => void;
  onError: () => void;
  formatViews: (views: number) => string;
  formatTimeAgo: (timestamp: string) => string;
}

export function VideoPlayerModal({
  video,
  videoError,
  onClose,
  onError,
  formatViews,
  formatTimeAgo,
}: VideoPlayerModalProps) {
  if (!video) return null;

  return (
    <div
      className="fixed inset-0 bg-black/95 z-50 flex items-center justify-center p-4 animate-fadeIn"
      onClick={onClose}
    >
      {/* Close Button */}
      <button
        onClick={onClose}
        className="fixed top-4 right-4 z-60 p-2 bg-neutral-900/90 hover:bg-neutral-800 rounded-full transition-colors border border-neutral-800"
      >
        <X size={24} className="text-white" />
      </button>

      <div
        className="relative w-full max-w-5xl bg-neutral-950 rounded-xl overflow-hidden animate-scaleIn"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Video Player */}
        <div className="relative w-full" style={{ paddingBottom: '56.25%' }}>
          {!videoError ? (
            <iframe
              src={`https://geo.dailymotion.com/player.html?video=${video.id}&autoplay=1`}
              className="absolute top-0 left-0 w-full h-full"
              allow="autoplay; fullscreen; picture-in-picture"
              allowFullScreen
              title={video.title}
              onError={onError}
            />
          ) : (
            <div className="absolute top-0 left-0 w-full h-full flex flex-col items-center justify-center bg-neutral-950 gap-4">
              <AlertCircle size={56} className="text-red-400" />
              <p className="text-white text-xl font-medium">视频加载失败</p>
              <a
                href={`https://www.dailymotion.com/video/${video.id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="px-5 py-2.5 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors font-medium"
              >
                在 Dailymotion 上观看
              </a>
            </div>
          )}
        </div>

        {/* Video Info */}
        <div className="p-5 md:p-6 space-y-3 bg-neutral-950">
          <h2 className="text-sm font-semibold text-white leading-snug">{video.title}</h2>
          <div className="flex items-center flex-wrap gap-3 text-xs text-gray-400">
            {video.views_total !== undefined && (
              <div className="flex items-center gap-1.5">
                <Eye size={14} />
                <span>{formatViews(video.views_total)}</span>
              </div>
            )}
            {video.created_time && (
              <div className="flex items-center gap-1.5">
                <Clock size={14} />
                <span>{formatTimeAgo(video.created_time)}</span>
              </div>
            )}
            <div className="flex items-center gap-1.5">
              <Play size={14} />
              <span>{video.duration}</span>
            </div>
          </div>
        </div>
      </div>

      <style jsx>{`
        @keyframes fadeIn {
          from {
            opacity: 0;
          }
          to {
            opacity: 1;
          }
        }
        @keyframes scaleIn {
          from {
            opacity: 0;
            transform: scale(0.9);
          }
          to {
            opacity: 1;
            transform: scale(1);
          }
        }
        .animate-fadeIn {
          animation: fadeIn 0.2s ease-out;
        }
        .animate-scaleIn {
          animation: scaleIn 0.3s ease-out;
        }
      `}</style>
    </div>
  );
}
