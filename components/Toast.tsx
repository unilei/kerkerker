'use client';

import { useEffect, useState } from 'react';

interface ToastProps {
  message: string;
  type?: 'success' | 'error' | 'warning' | 'info';
  onClose: () => void;
  duration?: number;
}

export function Toast({ message, type = 'info', onClose, duration = 3000 }: ToastProps) {
  useEffect(() => {
    const timer = setTimeout(() => {
      onClose();
    }, duration);

    return () => clearTimeout(timer);
  }, [duration, onClose]);

  const bgColor = {
    success: 'bg-green-500',
    error: 'bg-red-500',
    warning: 'bg-yellow-500',
    info: 'bg-blue-500'
  }[type];

  const icon = {
    success: '✓',
    error: '✕',
    warning: '⚠',
    info: 'ℹ'
  }[type];

  return (
    <div className="fixed top-4 right-4 z-50 animate-slide-in">
      <div className={`${bgColor} text-white px-6 py-3 rounded-lg shadow-lg flex items-center gap-3 min-w-[300px]`}>
        <span className="text-xl">{icon}</span>
        <span className="flex-1">{message}</span>
        <button
          onClick={onClose}
          className="text-white/80 hover:text-white transition"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

interface ConfirmDialogProps {
  title: string;
  message: string;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

export function ConfirmDialog({
  title,
  message,
  onConfirm,
  onCancel,
  confirmText = '确定',
  cancelText = '取消',
  danger = false
}: ConfirmDialogProps) {
  const [isLoading, setIsLoading] = useState(false);

  const handleConfirm = async () => {
    setIsLoading(true);
    try {
      await Promise.resolve(onConfirm());
      // 操作成功后自动关闭弹框
      onCancel();
    } catch (error) {
      console.error('操作失败:', error);
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in">
      <div className="bg-slate-800 rounded-xl shadow-2xl border border-slate-700 max-w-md w-full mx-4 animate-scale-in">
        <div className="p-6">
          <h3 className="text-xl font-bold text-white mb-2">{title}</h3>
          <p className="text-slate-300">{message}</p>
        </div>
        <div className="flex gap-3 px-6 pb-6">
          <button
            onClick={onCancel}
            disabled={isLoading}
            className="flex-1 px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {cancelText}
          </button>
          <button
            onClick={handleConfirm}
            disabled={isLoading}
            className={`flex-1 px-4 py-2 text-white rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed ${
              danger
                ? 'bg-red-600 hover:bg-red-700'
                : 'bg-blue-600 hover:bg-blue-700'
            }`}
          >
            {isLoading ? '处理中...' : confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
