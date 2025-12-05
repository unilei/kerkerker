'use client';

import { useState } from 'react';
import { VodSource } from '@/types/drama';
import { presetVodSources } from '@/lib/preset-vod-sources';
import { Modal } from '@/components/Modal';
import type { VodSourcesTabProps } from './types';

export function VodSourcesTab({
  sources,
  selectedKey,
  onSourcesChange,
  onSelectedKeyChange,
  onShowToast,
  onShowConfirm,
}: VodSourcesTabProps) {
  const [editingSource, setEditingSource] = useState<VodSource | null>(null);
  const [isAddMode, setIsAddMode] = useState(false);
  const [formData, setFormData] = useState<VodSource>({
    key: '',
    name: '',
    api: '',
    playUrl: '',
    type: 'json',
  });

  const handleImportPreset = () => {
    onShowConfirm({
      title: '导入预设配置',
      message: '确定要导入预设视频源吗？这将覆盖当前配置。',
      onConfirm: async () => {
        try {
          const response = await fetch('/api/vod-sources', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sources: presetVodSources,
              selected: presetVodSources[0]?.key || null,
            }),
          });

          const result = await response.json();

          if (result.code !== 200) {
            onShowToast({
              message: result.message || '导入视频源失败',
              type: 'error',
            });
            return;
          }

          onSourcesChange(presetVodSources);
          if (presetVodSources.length > 0) {
            onSelectedKeyChange(presetVodSources[0].key);
          }

          onShowToast({
            message: '已成功导入预设视频源',
            type: 'success',
          });
        } catch (error) {
          console.error('导入失败:', error);
          onShowToast({ message: '导入失败', type: 'error' });
        }
      },
      danger: false,
    });
  };

  const handleAdd = () => {
    setFormData({
      key: '',
      name: '',
      api: '',
      playUrl: '',
      type: 'json',
    });
    setIsAddMode(true);
    setEditingSource(null);
  };

  const handleEdit = (source: VodSource) => {
    setFormData({ ...source });
    setEditingSource(source);
    setIsAddMode(false);
  };

  const handleDelete = (key: string) => {
    const sourceToDelete = sources.find((s) => s.key === key);
    onShowConfirm({
      title: '删除视频源',
      message: `确定要删除「${sourceToDelete?.name}」吗？`,
      onConfirm: async () => {
        try {
          const newSources = sources.filter((s) => s.key !== key);
          const newSelected =
            selectedKey === key && newSources.length > 0
              ? newSources[0].key
              : selectedKey;

          const response = await fetch('/api/vod-sources', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sources: newSources,
              selected: newSelected,
            }),
          });

          const result = await response.json();

          if (result.code === 200) {
            onSourcesChange(newSources);
            onSelectedKeyChange(newSelected);
            onShowToast({ message: '删除成功', type: 'success' });
          } else {
            onShowToast({
              message: result.message || '删除失败',
              type: 'error',
            });
          }
        } catch (error) {
          console.error('删除失败:', error);
          onShowToast({ message: '删除失败', type: 'error' });
        }
      },
      danger: true,
    });
  };

  const handleSave = async () => {
    if (
      !formData.key ||
      !formData.name ||
      !formData.api ||
      !formData.playUrl
    ) {
      onShowToast({ message: '请填写完整信息', type: 'warning' });
      return;
    }

    let newSources: VodSource[];

    if (isAddMode) {
      if (sources.some((s) => s.key === formData.key)) {
        onShowToast({ message: '视频源key已存在', type: 'error' });
        return;
      }
      newSources = [...sources, formData];
    } else {
      newSources = sources.map((s) =>
        s.key === editingSource?.key ? formData : s
      );
    }

    try {
      const response = await fetch('/api/vod-sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sources: newSources,
          selected: selectedKey,
        }),
      });

      const result = await response.json();

      if (result.code === 200) {
        onSourcesChange(newSources);
        handleCancel();
        onShowToast({ message: '保存成功', type: 'success' });
      } else {
        onShowToast({
          message: result.message || '保存失败',
          type: 'error',
        });
      }
    } catch (error) {
      console.error('保存失败:', error);
      onShowToast({ message: '保存失败', type: 'error' });
    }
  };

  const handleCancel = () => {
    setEditingSource(null);
    setIsAddMode(false);
  };

  const handleSelectSource = async (key: string) => {
    try {
      const response = await fetch('/api/vod-sources', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selected: key }),
      });

      const result = await response.json();

      if (result.code === 200) {
        onSelectedKeyChange(key);
      } else {
        onShowToast({
          message: result.message || '选择失败',
          type: 'error',
        });
      }
    } catch (error) {
      console.error('选择视频源失败:', error);
      onShowToast({ message: '选择失败', type: 'error' });
    }
  };

  return (
    <div className="space-y-6">
      {/* Actions */}
      <div className="flex gap-4">
        <button
          onClick={handleAdd}
          className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition font-medium"
        >
          + 添加视频源
        </button>
        <button
          onClick={handleImportPreset}
          className="px-6 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg transition font-medium"
        >
          📥 导入预设配置
        </button>
      </div>

      {/* Edit/Add Modal */}
      <Modal
        isOpen={!!(editingSource || isAddMode)}
        onClose={handleCancel}
        title={isAddMode ? '添加视频源' : '编辑视频源'}
        size="lg"
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              Key (唯一标识)
            </label>
            <input
              type="text"
              value={formData.key}
              onChange={(e) =>
                setFormData({ ...formData, key: e.target.value })
              }
              disabled={!isAddMode}
              className="w-full px-4 py-2 bg-slate-900/50 border border-slate-600 rounded-lg text-white disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="例如: rycjapi"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              名称
            </label>
            <input
              type="text"
              value={formData.name}
              onChange={(e) =>
                setFormData({ ...formData, name: e.target.value })
              }
              className="w-full px-4 py-2 bg-slate-900/50 border border-slate-600 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="例如: 如意资源站"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              API地址
            </label>
            <input
              type="text"
              value={formData.api}
              onChange={(e) =>
                setFormData({ ...formData, api: e.target.value })
              }
              className="w-full px-4 py-2 bg-slate-900/50 border border-slate-600 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="https://..."
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              播放地址
            </label>
            <input
              type="text"
              value={formData.playUrl}
              onChange={(e) =>
                setFormData({ ...formData, playUrl: e.target.value })
              }
              className="w-full px-4 py-2 bg-slate-900/50 border border-slate-600 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="https://..."
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              类型
            </label>
            <select
              value={formData.type}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  type: e.target.value as 'json' | 'xml',
                })
              }
              className="w-full px-4 py-2 bg-slate-900/50 border border-slate-600 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="json">JSON</option>
              <option value="xml">XML</option>
            </select>
          </div>
        </div>
        <div className="flex gap-3 mt-6">
          <button
            onClick={handleSave}
            className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition font-medium"
          >
            保存
          </button>
          <button
            onClick={handleCancel}
            className="px-6 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg transition font-medium"
          >
            取消
          </button>
        </div>
      </Modal>

      {/* Sources List */}
      <div className="bg-slate-800/50 backdrop-blur-sm rounded-xl p-6 border border-slate-700">
        <h2 className="text-xl font-bold text-white mb-4">已配置的视频源</h2>
        <div className="space-y-3">
          {sources.map((source) => (
            <div
              key={source.key}
              className={`p-4 rounded-lg border transition ${
                selectedKey === source.key
                  ? 'bg-blue-500/10 border-blue-500'
                  : 'bg-slate-900/50 border-slate-700 hover:border-slate-600'
              }`}
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-2">
                    <h3 className="text-lg font-semibold text-white">
                      {source.name}
                    </h3>
                    <span className="text-xs px-2 py-1 bg-slate-700 text-slate-300 rounded">
                      {source.key}
                    </span>
                    {selectedKey === source.key && (
                      <span className="text-xs px-2 py-1 bg-blue-500 text-white rounded">
                        当前使用
                      </span>
                    )}
                  </div>
                  <div className="text-sm text-slate-400 space-y-1">
                    <p>API: {source.api}</p>
                    <p>播放: {source.playUrl}</p>
                    <p>类型: {source.type.toUpperCase()}</p>
                  </div>
                </div>
                <div className="flex gap-2 ml-4">
                  {selectedKey !== source.key && (
                    <button
                      onClick={() => handleSelectSource(source.key)}
                      className="px-3 py-1 bg-green-600 hover:bg-green-700 text-white text-sm rounded transition"
                    >
                      设为当前
                    </button>
                  )}
                  <button
                    onClick={() => handleEdit(source)}
                    className="px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded transition"
                  >
                    编辑
                  </button>
                  <button
                    onClick={() => handleDelete(source.key)}
                    className="px-3 py-1 bg-red-600 hover:bg-red-700 text-white text-sm rounded transition"
                  >
                    删除
                  </button>
                </div>
              </div>
            </div>
          ))}
          {sources.length === 0 && (
            <div className="text-center py-12 text-slate-400">
              <p className="text-lg mb-2">⚠️ 暂无视频源配置</p>
              <p className="text-sm">
                请点击上方「添加视频源」手动添加，或点击「导入预设配置」快速配置
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
