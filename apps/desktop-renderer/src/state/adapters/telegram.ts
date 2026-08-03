import type {
  TelegramSettingsState,
  TelegramSettingsView,
} from "../../settings/telegram-controller.js";
import { CLOSED_PANE, type TelegramSettingsPort } from "../settings-slice.js";

export interface TelegramSettingsAdapter {
  readonly view: TelegramSettingsView;
  readonly port: TelegramSettingsPort;
}

export function createTelegramSettingsAdapter(input: {
  readonly publish: (state: TelegramSettingsState) => void;
}): TelegramSettingsAdapter {
  let handlers: Parameters<TelegramSettingsView["bind"]>[0] | undefined;
  let disposed = false;
  return {
    view: {
      bind(next) {
        handlers = next;
      },
      close() {
        if (!disposed) input.publish(CLOSED_PANE);
      },
      render(state) {
        if (!disposed) input.publish(state);
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        handlers = undefined;
        input.publish(CLOSED_PANE);
      },
    },
    port: {
      retry: () => handlers?.onRetry(),
      pasteToken: () => handlers?.onPasteToken(),
      enable: () => handlers?.onEnable(),
      disable: () => handlers?.onDisable(),
      remove: () => handlers?.onRemove(),
      reconcile: () => handlers?.onReconcile(),
      removeWebhook: () => handlers?.onRemoveWebhook(),
      beginPairing: () => handlers?.onBeginPairing(),
      cancelPairing: () => handlers?.onCancelPairing(),
      acknowledgeGapWarning: () => handlers?.onAcknowledgeGapWarning(),
      addSender: (senderId) => handlers?.onAddSender(senderId),
      removeSender: (senderId) => handlers?.onRemoveSender(senderId),
    },
  };
}
