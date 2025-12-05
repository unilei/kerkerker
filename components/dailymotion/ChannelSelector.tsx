import { User } from 'lucide-react';
import type { DailymotionChannelConfig } from '@/types/dailymotion-config';

interface ChannelSelectorProps {
  channels: DailymotionChannelConfig[];
  activeChannelId: string | null;
  onChannelSwitch: (channelId: string) => void;
}

export function ChannelSelector({ channels, activeChannelId, onChannelSwitch }: ChannelSelectorProps) {
  if (channels.length <= 1) return null;

  return (
    <div className="px-3 md:px-6 lg:px-10 py-3 border-b border-neutral-900">
      <div className="flex gap-3 overflow-x-auto scrollbar-hide p-1">
        {channels.map((channel) => {
          const isActive = channel.id === activeChannelId;
          return (
            <button
              key={channel.id}
              onClick={() => onChannelSwitch(channel.id)}
              className="flex flex-col items-center gap-2 shrink-0 group"
            >
              <div
                className={`relative rounded-full transition-all duration-200 ${
                  isActive
                    ? 'ring-2 ring-red-600'
                    : 'ring-1 ring-neutral-800 group-hover:ring-neutral-700'
                }`}
              >
                {channel.avatarUrl ? (
                  <img
                    src={channel.avatarUrl}
                    alt={channel.displayName}
                    className="w-14 h-14 md:w-16 md:h-16 rounded-full object-cover"
                  />
                ) : (
                  <div className="w-14 h-14 md:w-16 md:h-16 rounded-full bg-neutral-900 flex items-center justify-center">
                    <User size={20} className="text-gray-400" />
                  </div>
                )}
              </div>
              <span
                className={`text-xs transition-colors duration-200 ${
                  isActive ? 'text-white font-medium' : 'text-gray-400 group-hover:text-gray-300'
                }`}
              >
                {channel.displayName}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
