export interface ToastState {
  message: string;
  type: "success" | "error" | "warning" | "info";
}

export interface ConfirmState {
  title: string;
  message: string;
  onConfirm: () => void | Promise<void>;
  danger?: boolean;
}

export interface PanResourcesTabProps {
  onShowToast: (toast: ToastState) => void;
  onShowConfirm: (confirm: ConfirmState) => void;
}
