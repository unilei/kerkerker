"use client";

import { useState, useEffect, useMemo, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { VodSource } from "@/types/drama";
import { ShortDramaSource } from "@/types/shorts-source";
import { Toast, ConfirmDialog } from "@/components/Toast";
import type { PlayerConfig } from "@/app/api/player-config/route";
import { VodSourcesTab } from "@/components/admin/VodSourcesTab";
import { PlayerConfigTab } from "@/components/admin/PlayerConfigTab";
import { DailymotionChannelsTab } from "@/components/admin/DailymotionChannelsTab";
import { ShortsSourcesTab } from "@/components/admin/ShortsSourcesTab";
import { DatabaseSettingsTab } from "@/components/admin/DatabaseSettingsTab";
import { PanResourcesTab } from "@/components/admin/PanResourcesTab";
import type {
  ToastState,
  ConfirmState,
  UnifiedImportCallbacks,
} from "@/components/admin/types";
import type { DailymotionChannelConfig } from "@/types/dailymotion-config";
import { Tv, Film, Youtube, Settings, Database, HardDrive } from "lucide-react";

type TabType = "sources" | "shorts" | "dailymotion" | "player" | "database" | "pan";

const VALID_TABS: TabType[] = ["sources", "shorts", "dailymotion", "player", "database", "pan"];

function SettingsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // 从 URL 读取初始 tab
  const getInitialTab = (): TabType => {
    const urlTab = searchParams.get("tab");
    if (urlTab && VALID_TABS.includes(urlTab as TabType)) {
      return urlTab as TabType;
    }
    return "sources";
  };

  const [activeTab, setActiveTab] = useState<TabType>(getInitialTab);
  const [sources, setSources] = useState<VodSource[]>([]);
  const [selectedKey, setSelectedKey] = useState<string>("");
  const [shortsSources, setShortsSources] = useState<ShortDramaSource[]>([]);
  const [selectedShortsKey, setSelectedShortsKey] = useState<string>("");
  const [playerConfig, setPlayerConfig] = useState<PlayerConfig | null>(null);
  const [dailymotionChannels, setDailymotionChannels] = useState<
    DailymotionChannelConfig[]
  >([]);
  const [defaultChannelId, setDefaultChannelId] = useState<
    string | undefined
  >();
  const [toast, setToast] = useState<ToastState | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  // 切换 tab 时更新 URL
  const handleTabChange = (tab: TabType) => {
    setActiveTab(tab);
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", tab);
    router.replace(`?${params.toString()}`, { scroll: false });
  };

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const vodResponse = await fetch("/api/vod-sources");
        const vodResult = await vodResponse.json();

        if (vodResult.code === 200 && vodResult.data) {
          setSources(vodResult.data.sources || []);
          setSelectedKey(vodResult.data.selected?.key || "");
        }

        // 加载短剧源配置
        const shortsResponse = await fetch("/api/shorts-sources");
        const shortsResult = await shortsResponse.json();

        if (shortsResult.code === 200 && shortsResult.data) {
          setShortsSources(shortsResult.data.sources || []);
          setSelectedShortsKey(shortsResult.data.selected?.key || "");
        }

        const playerResponse = await fetch("/api/player-config");
        const playerResult = await playerResponse.json();

        if (playerResult.code === 200 && playerResult.data) {
          setPlayerConfig(playerResult.data);
        }

        const dailymotionResponse = await fetch("/api/dailymotion-config");
        const dailymotionResult = await dailymotionResponse.json();

        if (dailymotionResult.code === 200 && dailymotionResult.data) {
          setDailymotionChannels(dailymotionResult.data.channels || []);
          setDefaultChannelId(dailymotionResult.data.defaultChannelId);
        }
      } catch (error) {
        setToast({
          message: error instanceof Error ? error.message : "加载配置失败",
          type: "error",
        });
      }
    };

    loadSettings();
  }, []);

  const handleLogout = async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      router.push("/login");
      router.refresh();
    } catch (error) {
      console.error("Logout error:", error);
    }
  };

  // 统一导入回调 - 允许任意 Tab 更新所有类型的源
  const unifiedImportCallbacks: UnifiedImportCallbacks = useMemo(
    () => ({
      onVodSourcesImport: (newSources, selected) => {
        setSources(newSources);
        if (selected) setSelectedKey(selected);
      },
      onShortsSourcesImport: (newSources, selected) => {
        setShortsSources(newSources);
        if (selected) setSelectedShortsKey(selected);
      },
      onDailymotionImport: (channels, defaultId) => {
        setDailymotionChannels(channels);
        if (defaultId) setDefaultChannelId(defaultId);
      },
    }),
    []
  );

  const tabs = [
    { id: "sources" as TabType, name: "视频源管理", icon: Tv },
    { id: "shorts" as TabType, name: "短剧源管理", icon: Film },
    { id: "dailymotion" as TabType, name: "Dailymotion", icon: Youtube },
    { id: "player" as TabType, name: "播放器设置", icon: Settings },
    { id: "pan" as TabType, name: "网盘资源", icon: HardDrive },
    { id: "database" as TabType, name: "数据库", icon: Database },
  ];

  return (
    <div className="min-h-screen bg-[#141414]">
      {/* Header - Netflix Style */}
      <div className="bg-[#141414] border-b border-[#333]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex justify-between items-center">
          <div className="flex items-center gap-6">
            <h1 className="text-2xl font-bold text-[#E50914]">壳儿</h1>
            <span className="text-white text-lg">系统设置</span>
          </div>
          <button
            onClick={handleLogout}
            className="px-4 py-2 bg-[#333] hover:bg-[#444] text-white rounded transition-colors"
          >
            退出登录
          </button>
        </div>
      </div>

      {/* Tabs Navigation - Netflix Style */}
      <div className="bg-[#181818] border-b border-[#333]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <nav className="flex space-x-1">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  onClick={() => handleTabChange(tab.id)}
                  className={`px-6 py-4 text-sm font-medium transition-all relative ${
                    activeTab === tab.id
                      ? "text-white"
                      : "text-[#808080] hover:text-white"
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <Icon size={18} strokeWidth={1.5} />
                    <span>{tab.name}</span>
                  </span>
                  {activeTab === tab.id && (
                    <div className="absolute bottom-0 left-0 right-0 h-[3px] bg-[#E50914]" />
                  )}
                </button>
              );
            })}
          </nav>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {activeTab === "sources" && (
          <VodSourcesTab
            sources={sources}
            selectedKey={selectedKey}
            onSourcesChange={setSources}
            onSelectedKeyChange={setSelectedKey}
            onShowToast={setToast}
            onShowConfirm={setConfirm}
            unifiedImport={unifiedImportCallbacks}
          />
        )}

        {activeTab === "shorts" && (
          <ShortsSourcesTab
            sources={shortsSources}
            selectedKey={selectedShortsKey}
            onSourcesChange={setShortsSources}
            onSelectedKeyChange={setSelectedShortsKey}
            onShowToast={setToast}
            onShowConfirm={setConfirm}
            unifiedImport={unifiedImportCallbacks}
          />
        )}

        {activeTab === "player" && playerConfig && (
          <PlayerConfigTab
            playerConfig={playerConfig}
            onConfigChange={setPlayerConfig}
            onShowToast={setToast}
            onShowConfirm={setConfirm}
          />
        )}

        {activeTab === "dailymotion" && (
          <DailymotionChannelsTab
            channels={dailymotionChannels}
            defaultChannelId={defaultChannelId}
            onChannelsChange={(channels, defaultId) => {
              setDailymotionChannels(channels);
              setDefaultChannelId(defaultId);
            }}
            onShowToast={setToast}
            onShowConfirm={setConfirm}
            unifiedImport={unifiedImportCallbacks}
          />
        )}

        {activeTab === "pan" && (
          <PanResourcesTab
            onShowToast={setToast}
            onShowConfirm={setConfirm}
          />
        )}

        {activeTab === "database" && (
          <DatabaseSettingsTab
            onShowToast={setToast}
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

// 加载占位符
function SettingsLoading() {
  return (
    <div className="min-h-screen bg-[#141414] flex items-center justify-center">
      <div className="text-center">
        <div className="animate-spin rounded-full h-12 w-12 border-2 border-gray-600 border-t-red-600 mx-auto mb-4" />
        <p className="text-gray-400">加载中...</p>
      </div>
    </div>
  );
}

// 主页面组件 - 用 Suspense 包装
export default function SettingsPage() {
  return (
    <Suspense fallback={<SettingsLoading />}>
      <SettingsContent />
    </Suspense>
  );
}
