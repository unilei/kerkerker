import { VodSource } from '@/types/drama';
import type { PlayerConfig } from '@/app/api/player-config/route';

export interface ToastState {
  message: string;
  type: 'success' | 'error' | 'warning' | 'info';
}

export interface ConfirmState {
  title: string;
  message: string;
  onConfirm: () => void | Promise<void>;
  danger?: boolean;
}

export interface VodSourcesTabProps {
  sources: VodSource[];
  selectedKey: string;
  onSourcesChange: (sources: VodSource[]) => void;
  onSelectedKeyChange: (key: string) => void;
  onShowToast: (toast: ToastState) => void;
  onShowConfirm: (confirm: ConfirmState) => void;
}

export interface PlayerConfigTabProps {
  playerConfig: PlayerConfig;
  onConfigChange: (config: PlayerConfig) => void;
  onShowToast: (toast: ToastState) => void;
  onShowConfirm: (confirm: ConfirmState) => void;
}
