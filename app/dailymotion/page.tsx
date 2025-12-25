"use client";

import { useState, useEffect, useCallback, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertCircle, Home } from "lucide-react";
import Link from "next/link";
import { DailymotionChannel, DailymotionVideo } from "@/types/dailymotion";
import type { DailymotionChannelConfig } from "@/types/dailymotion-config";
import { ChannelSelector } from "@/components/dailymotion/ChannelSelector";
import { VideoCard } from "@/components/dailymotion/VideoCard";
import { Pagination } from "@/components/dailymotion/Pagination";
import { VideoPlayerModal } from "@/components/dailymotion/VideoPlayerModal";
import { LoadingSkeleton } from "@/components/dailymotion/LoadingSkeleton";

function DailymotionContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [channels, setChannels] = useState<DailymotionChannelConfig[]>([]);
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  const [channelData, setChannelData] = useState<DailymotionChannel | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [selectedVideo, setSelectedVideo] = useState<DailymotionVideo | null>(null);
  const [videoError, setVideoError] = useState(false);

  // 加载频道配置
  const fetchChannelConfig = async () => {
    try {
      const response = await fetch('/api/dailymotion-config');
      const result = await response.json();
      
      if (result.code === 200 && result.data) {
        const activeChannels = result.data.channels.filter((c: DailymotionChannelConfig) => c.isActive);
        setChannels(activeChannels);
        
        // 设置默认频道或第一个频道
        const defaultId = result.data.defaultChannelId || activeChannels[0]?.id;
        setActiveChannelId(defaultId);
      }
    } catch (err) {
      console.error('Failed to load channel config:', err);
      // 如果没有配置，使用默认频道
      setChannels([{
        id: 'default',
        username: 'kchow125',
        displayName: 'KChow125',
        isActive: true,
        createdAt: new Date().toISOString(),
      }]);
      setActiveChannelId('default');
    }
  };

  // 加载频道数据
  const fetchChannelData = useCallback(async (username: string, page: number) => {
    try {
      setLoading(true);
      
      const response = await fetch(`/api/dailymotion?username=${username}&page=${page}`);
      
      if (!response.ok) {
        throw new Error('Failed to fetch channel data');
      }
      
      const data: DailymotionChannel = await response.json();
      setChannelData(data);
      setHasMore(data.hasMore || false);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

  // 初始化：加载频道配置
  useEffect(() => {
    fetchChannelConfig();
  }, []);

  // 从 URL 读取页码和频道
  useEffect(() => {
    const pageFromUrl = parseInt(searchParams.get('page') || '1', 10);
    const channelFromUrl = searchParams.get('channel');
    
    setCurrentPage(pageFromUrl);
    
    // 如果URL有频道参数且频道列表已加载，设置活跃频道
    if (channelFromUrl && channels.length > 0) {
      const channelExists = channels.find(c => c.username === channelFromUrl);
      if (channelExists) {
        setActiveChannelId(channelExists.id);
      }
    }
  }, [searchParams, channels]);

  // 当频道或页码变化时：加载数据
  useEffect(() => {
    if (activeChannelId && channels.length > 0) {
      const channel = channels.find((c) => c.id === activeChannelId);
      if (channel) {
        fetchChannelData(channel.username, currentPage);
      }
    }
  }, [activeChannelId, channels, currentPage, fetchChannelData]);

  const handleChannelSwitch = (channelId: string) => {
    const channel = channels.find(c => c.id === channelId);
    if (!channel) return;
    
    setActiveChannelId(channelId);
    setCurrentPage(1);
    
    // 更新URL：包含channel和page参数
    const url = new URL(window.location.href);
    url.searchParams.set('channel', channel.username);
    url.searchParams.set('page', '1');
    window.history.pushState({}, '', url.toString());
    router.push(`/dailymotion?channel=${channel.username}&page=1`, { scroll: false });
  };

  const handleVideoClick = (video: DailymotionVideo) => {
    setSelectedVideo(video);
    setVideoError(false); // 重置错误状态
  };

  const handlePageChange = (page: number) => {
    const channel = channels.find(c => c.id === activeChannelId);
    if (!channel) return;
    
    setCurrentPage(page);
    
    // 使用 window.history 更新 URL 以确保参数显示
    const url = new URL(window.location.href);
    url.searchParams.set('channel', channel.username);
    url.searchParams.set('page', page.toString());
    window.history.pushState({}, '', url.toString());
    router.push(`/dailymotion?channel=${channel.username}&page=${page}`, { scroll: false });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const formatViews = (views: number) => {
    if (views >= 1000000) return `${(views / 1000000).toFixed(1)}M`;
    if (views >= 1000) return `${(views / 1000).toFixed(1)}K`;
    return views.toString();
  };

  const formatTimeAgo = (timestamp: string) => {
    const now = Date.now();
    const time = Number(timestamp) * 1000;
    const diff = now - time;
    
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    const months = Math.floor(diff / 2592000000);
    const years = Math.floor(diff / 31536000000);
    
    if (years > 0) return `${years}年前`;
    if (months > 0) return `${months}个月前`;
    if (days > 0) return `${days}天前`;
    if (hours > 0) return `${hours}小时前`;
    if (minutes > 0) return `${minutes}分钟前`;
    return '刚刚';
  };

  if (loading) {
    return <LoadingSkeleton />;
  }

  if (error || !channelData) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center p-8">
        <div className="text-center">
          <AlertCircle className="w-16 h-16 text-red-500 mx-auto mb-4" />
          <h2 className="text-white text-2xl font-bold mb-2">
            {error || 'Failed to load channel data'}
          </h2>
          <p className="text-gray-400">请稍后再试或检查频道名称</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black text-white">
      <style jsx global>{`
        .scrollbar-hide::-webkit-scrollbar {
          display: none;
        }
        .scrollbar-hide {
          -ms-overflow-style: none;
          scrollbar-width: none;
        }
      `}</style>
      
      {/* Top Navigation */}
      <div className="px-3 md:px-6 lg:px-10 py-3 border-b border-neutral-900">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-gray-400 hover:text-red-600 transition-colors text-sm group"
        >
          <Home size={18} className="group-hover:scale-110 transition-transform" />
          <span className="font-medium">返回首页</span>
        </Link>
      </div>
      
      {/* Channel Selector */}
      <ChannelSelector
        channels={channels}
        activeChannelId={activeChannelId}
        onChannelSwitch={handleChannelSwitch}
      />

      {/* Video Grid Section */}
      <div className="px-3 md:px-6 lg:px-10 py-4">
        <h2 className="text-lg md:text-xl font-semibold mb-4 px-1">推荐短剧</h2>
        {/* Video Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-6 2xl:grid-cols-10 gap-3 md:gap-4">
          {channelData.videos.map((video) => (
            <VideoCard
              key={video.id}
              video={video}
              onClick={() => handleVideoClick(video)}
              formatTimeAgo={formatTimeAgo}
            />
          ))}
        </div>

        {/* Pagination */}
        {channelData.videos.length > 0 && (
          <Pagination
            currentPage={currentPage}
            hasMore={hasMore}
            onPageChange={handlePageChange}
          />
        )}
      </div>

      {/* Video Player Modal */}
      <VideoPlayerModal
        video={selectedVideo}
        videoError={videoError}
        onClose={() => setSelectedVideo(null)}
        onError={() => setVideoError(true)}
        formatViews={formatViews}
        formatTimeAgo={formatTimeAgo}
      />
    </div>
  );
}

export default function DailymotionPage() {
  return (
    <Suspense fallback={<LoadingSkeleton />}>
      <DailymotionContent />
    </Suspense>
  );
}
