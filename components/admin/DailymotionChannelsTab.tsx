'use client';

import { useState } from 'react';
import { Plus, Edit2, Trash2, Star, Download, X } from 'lucide-react';
import type { DailymotionChannelConfig } from '@/types/dailymotion-config';
import { presetDailymotionChannels } from '@/lib/preset-dailymotion-channels';

interface Props {
  channels: DailymotionChannelConfig[];
  defaultChannelId?: string;
  onChannelsChange: (channels: DailymotionChannelConfig[], defaultChannelId?: string) => void;
  onShowToast: (toast: { message: string; type: 'success' | 'error' }) => void;
  onShowConfirm: (confirm: {
    title: string;
    message: string;
    onConfirm: () => void;
    danger?: boolean;
  }) => void;
}

export function DailymotionChannelsTab({
  channels,
  defaultChannelId,
  onChannelsChange,
  onShowToast,
  onShowConfirm,
}: Props) {
  const [showModal, setShowModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    username: '',
    displayName: '',
    avatarUrl: '',
  });
  const [importing, setImporting] = useState(false);

  const resetForm = () => {
    setFormData({ username: '', displayName: '', avatarUrl: '' });
    setShowModal(false);
    setEditingId(null);
  };

  const handleAdd = async () => {
    if (!formData.username.trim() || !formData.displayName.trim()) {
      onShowToast({ message: '请填写必填字段', type: 'error' });
      return;
    }

    try {
      const response = await fetch('/api/dailymotion-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'add',
          ...formData,
        }),
      });

      const result = await response.json();
      if (result.code === 200) {
        onChannelsChange(result.data.channels, result.data.defaultChannelId);
        onShowToast({ message: '频道添加成功', type: 'success' });
        resetForm();
      } else {
        throw new Error(result.message);
      }
    } catch (error) {
      onShowToast({
        message: error instanceof Error ? error.message : '添加失败',
        type: 'error',
      });
    }
  };

  const handleUpdate = async () => {
    if (!formData.username.trim() || !formData.displayName.trim()) {
      onShowToast({ message: '请填写必填字段', type: 'error' });
      return;
    }

    try {
      const response = await fetch('/api/dailymotion-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update',
          id: editingId,
          ...formData,
        }),
      });

      const result = await response.json();
      if (result.code === 200) {
        onChannelsChange(result.data.channels, result.data.defaultChannelId);
        onShowToast({ message: '频道更新成功', type: 'success' });
        resetForm();
      } else {
        throw new Error(result.message);
      }
    } catch (error) {
      onShowToast({
        message: error instanceof Error ? error.message : '更新失败',
        type: 'error',
      });
    }
  };

  const handleDelete = (channel: DailymotionChannelConfig) => {
    onShowConfirm({
      title: '删除频道',
      message: `确定要删除频道"${channel.displayName}"吗？`,
      danger: true,
      onConfirm: async () => {
        try {
          const response = await fetch('/api/dailymotion-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'delete',
              id: channel.id,
            }),
          });

          const result = await response.json();
          if (result.code === 200) {
            onChannelsChange(result.data.channels, result.data.defaultChannelId);
            onShowToast({ message: '频道删除成功', type: 'success' });
          } else {
            throw new Error(result.message);
          }
        } catch (error) {
          onShowToast({
            message: error instanceof Error ? error.message : '删除失败',
            type: 'error',
          });
        }
      },
    });
  };

  const handleSetDefault = async (channelId: string) => {
    try {
      const response = await fetch('/api/dailymotion-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'setDefault',
          id: channelId,
        }),
      });

      const result = await response.json();
      if (result.code === 200) {
        onChannelsChange(result.data.channels, result.data.defaultChannelId);
        onShowToast({ message: '默认频道设置成功', type: 'success' });
      } else {
        throw new Error(result.message);
      }
    } catch (error) {
      onShowToast({
        message: error instanceof Error ? error.message : '设置失败',
        type: 'error',
      });
    }
  };

  const startEdit = (channel: DailymotionChannelConfig) => {
    setEditingId(channel.id);
    setFormData({
      username: channel.username,
      displayName: channel.displayName,
      avatarUrl: channel.avatarUrl || '',
    });
    setShowModal(true);
  };

  const handleImportPreset = async () => {
    setImporting(true);
    try {
      // 依次添加预设频道
      for (const preset of presetDailymotionChannels) {
        // 检查是否已存在
        const exists = channels.some(c => c.username === preset.username);
        if (exists) {
          continue; // 跳过已存在的频道
        }

        const response = await fetch('/api/dailymotion-config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'add',
            ...preset,
          }),
        });

        const result = await response.json();
        if (result.code === 200) {
          onChannelsChange(result.data.channels, result.data.defaultChannelId);
        }
      }

      onShowToast({ message: '默认频道导入成功', type: 'success' });
      setShowImportModal(false);
    } catch (error) {
      onShowToast({
        message: error instanceof Error ? error.message : '导入失败',
        type: 'error',
      });
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-xl font-bold text-white">Dailymotion 频道管理</h2>
          <p className="text-slate-400 text-sm mt-1">管理 Dailymotion 频道列表</p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={() => setShowImportModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition"
          >
            <Download size={18} />
            导入默认频道
          </button>
          <button
            onClick={() => {
              setShowModal(true);
              setEditingId(null);
              setFormData({ username: '', displayName: '', avatarUrl: '' });
            }}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition"
          >
            <Plus size={18} />
            添加频道
          </button>
        </div>
      </div>

      {/* Add/Edit Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onClick={resetForm}>
          <div className="bg-slate-900 rounded-xl max-w-2xl w-full border border-slate-700 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            {/* Modal Header */}
            <div className="flex items-center justify-between p-6 border-b border-slate-700">
              <h3 className="text-xl font-bold text-white">
                {editingId ? '编辑频道' : '添加新频道'}
              </h3>
              <button
                onClick={resetForm}
                className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition"
              >
                <X size={20} />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-2">
                    用户名 <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="text"
                    value={formData.username}
                    onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                    placeholder="例如: kchow125"
                    className="w-full px-4 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-2">
                    显示名称 <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="text"
                    value={formData.displayName}
                    onChange={(e) => setFormData({ ...formData, displayName: e.target.value })}
                    placeholder="例如: KChow125"
                    className="w-full px-4 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
                  />
                </div>

                <div className="md:col-span-2">
                  <label className="block text-sm font-medium text-slate-300 mb-2">
                    头像 URL（可选）
                  </label>
                  <input
                    type="text"
                    value={formData.avatarUrl}
                    onChange={(e) => setFormData({ ...formData, avatarUrl: e.target.value })}
                    placeholder="https://..."
                    className="w-full px-4 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
                  />
                </div>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="flex justify-end gap-3 p-6 border-t border-slate-700">
              <button
                onClick={resetForm}
                className="px-6 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg transition"
              >
                取消
              </button>
              <button
                onClick={editingId ? handleUpdate : handleAdd}
                className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition"
              >
                {editingId ? '更新' : '添加'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Import Modal */}
      {showImportModal && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onClick={() => setShowImportModal(false)}>
          <div className="bg-slate-900 rounded-xl max-w-3xl w-full border border-slate-700 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            {/* Modal Header */}
            <div className="flex items-center justify-between p-6 border-b border-slate-700">
              <h3 className="text-xl font-bold text-white">导入默认频道</h3>
              <button
                onClick={() => setShowImportModal(false)}
                className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition"
              >
                <X size={20} />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6 space-y-4">
              <p className="text-slate-400">
                将导入以下 {presetDailymotionChannels.length} 个默认频道（已存在的频道将被跳过）：
              </p>
              
              <div className="max-h-96 overflow-y-auto space-y-2 border border-slate-700 rounded-lg p-4 bg-slate-800/50">
                {presetDailymotionChannels.map((preset, index) => (
                  <div key={index} className="flex items-center justify-between p-3 bg-slate-900/50 rounded-lg">
                    <div>
                      <div className="text-white font-medium">{preset.displayName}</div>
                      <div className="text-slate-400 text-sm">@{preset.username}</div>
                    </div>
                    {channels.some(c => c.username === preset.username) && (
                      <span className="text-xs text-yellow-400 bg-yellow-400/10 px-2 py-1 rounded">
                        已存在
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Modal Footer */}
            <div className="flex justify-end gap-3 p-6 border-t border-slate-700">
              <button
                onClick={() => setShowImportModal(false)}
                disabled={importing}
                className="px-6 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                取消
              </button>
              <button
                onClick={handleImportPreset}
                disabled={importing}
                className="flex items-center gap-2 px-6 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {importing ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    导入中...
                  </>
                ) : (
                  <>
                    <Download size={18} />
                    确认导入
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Channels List */}
      <div className="space-y-3">
        {channels.length === 0 ? (
          <div className="text-center py-12 text-slate-400">
            <p>暂无频道配置</p>
            <p className="text-sm mt-2">点击上方&ldquo;添加频道&rdquo;按钮开始配置</p>
          </div>
        ) : (
          channels.map((channel) => (
            <div
              key={channel.id}
              className="bg-slate-800/30 rounded-lg p-4 border border-slate-700 hover:border-slate-600 transition"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  {channel.avatarUrl ? (
                    <img
                      src={channel.avatarUrl}
                      alt={channel.displayName}
                      className="w-12 h-12 rounded-full"
                    />
                  ) : (
                    <div className="w-12 h-12 rounded-full bg-slate-700 flex items-center justify-center text-slate-400">
                      {channel.displayName.charAt(0).toUpperCase()}
                    </div>
                  )}
                  
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-white font-semibold">{channel.displayName}</h3>
                      {channel.id === defaultChannelId && (
                        <span className="flex items-center gap-1 text-xs text-yellow-400 bg-yellow-400/10 px-2 py-1 rounded">
                          <Star size={12} fill="currentColor" />
                          默认
                        </span>
                      )}
                    </div>
                    <p className="text-slate-400 text-sm">@{channel.username}</p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {channel.id !== defaultChannelId && (
                    <button
                      onClick={() => handleSetDefault(channel.id)}
                      className="p-2 text-slate-400 hover:text-yellow-400 hover:bg-slate-700 rounded-lg transition"
                      title="设为默认"
                    >
                      <Star size={18} />
                    </button>
                  )}
                  <button
                    onClick={() => startEdit(channel)}
                    className="p-2 text-slate-400 hover:text-blue-400 hover:bg-slate-700 rounded-lg transition"
                    title="编辑"
                  >
                    <Edit2 size={18} />
                  </button>
                  <button
                    onClick={() => handleDelete(channel)}
                    className="p-2 text-slate-400 hover:text-red-400 hover:bg-slate-700 rounded-lg transition"
                    title="删除"
                  >
                    <Trash2 size={18} />
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
