'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { VodSource } from '@/types/drama';
import { Toast, ConfirmDialog } from '@/components/Toast';
import type { PlayerConfig } from '@/app/api/player-config/route';
import { VodSourcesTab } from '@/components/admin/VodSourcesTab';
import { PlayerConfigTab } from '@/components/admin/PlayerConfigTab';
import type { ToastState, ConfirmState } from '@/components/admin/types';

type TabType = 'sources' | 'player';

export default function SettingsPage() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<TabType>('sources');
  const [sources, setSources] = useState<VodSource[]>([]);
  const [selectedKey, setSelectedKey] = useState<string>('');
  const [playerConfig, setPlayerConfig] = useState<PlayerConfig | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const vodResponse = await fetch('/api/vod-sources');
        const vodResult = await vodResponse.json();
        
        if (vodResult.code === 200 && vodResult.data) {
          setSources(vodResult.data.sources || []);
          setSelectedKey(vodResult.data.selected?.key || '');
        }
        
        const playerResponse = await fetch('/api/player-config');
        const playerResult = await playerResponse.json();
        
        if (playerResult.code === 200 && playerResult.data) {
          setPlayerConfig(playerResult.data);
        }
      } catch (error) {
        setToast({ message: error instanceof Error ? error.message : '加载配置失败', type: 'error' });
      }
    };
    
    loadSettings();
  }, []);

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      router.push('/login');
      router.refresh();
    } catch (error) {
      console.error('Logout error:', error);
    }
  };

  const tabs = [
    { id: 'sources' as TabType, name: '视频源管理', icon: '📺' },
    { id: 'player' as TabType, name: '播放器设置', icon: '▶️' }
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
      {/* Header */}
      <div className="bg-slate-800/50 backdrop-blur-sm border-b border-slate-700">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex justify-between items-center">
          <h1 className="text-2xl font-bold text-white">系统设置</h1>
          <button
            onClick={handleLogout}
            className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg transition"
          >
            退出登录
          </button>
        </div>
      </div>

      {/* Tabs Navigation */}
      <div className="bg-slate-800/30 backdrop-blur-sm border-b border-slate-700">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <nav className="flex space-x-1">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-6 py-4 text-sm font-medium transition-all relative ${
                  activeTab === tab.id
                    ? 'text-white bg-slate-800/50'
                    : 'text-slate-400 hover:text-slate-300 hover:bg-slate-800/20'
                }`}
              >
                <span className="flex items-center gap-2">
                  <span>{tab.icon}</span>
                  <span>{tab.name}</span>
                </span>
                {activeTab === tab.id && (
                  <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-500" />
                )}
              </button>
            ))}
          </nav>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {activeTab === 'sources' && (
          <VodSourcesTab
            sources={sources}
            selectedKey={selectedKey}
            onSourcesChange={setSources}
            onSelectedKeyChange={setSelectedKey}
            onShowToast={setToast}
            onShowConfirm={setConfirm}
          />
        )}

        {activeTab === 'player' && playerConfig && (
          <PlayerConfigTab
            playerConfig={playerConfig}
            onConfigChange={setPlayerConfig}
            onShowToast={setToast}
            onShowConfirm={setConfirm}
          />
        )}
      </div>

      {/* Toast 通知 */}
      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onClose={() => setToast(null)}
        />
      )}

      {/* 确认对话框 */}
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          message={confirm.message}
          onConfirm={confirm.onConfirm}
          onCancel={() => setConfirm(null)}
          danger={confirm.danger}
        />
      )}
    </div>
  );
}
