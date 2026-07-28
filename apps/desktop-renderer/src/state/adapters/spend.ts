import type { SpendSummary } from "@enduragent/coach-contract";
import type { SpendMeterView } from "../../spend-meter/controller.js";
import type { SpendSettingsPort, SpendSurfaceState } from "../settings-slice.js";

export const SPEND_CAP_REACHED_PREFIX = "You’ve reached today’s ";

export function currency(value: number, detail = false): string {
  if (value === 0) return "$0.00";
  if (value > 0 && value < 0.01) return detail ? `$${value.toFixed(4)}` : "<$0.01";
  return `$${value.toFixed(2)}`;
}

export function capWarningCopy(summary: SpendSummary): string | null {
  if (summary.capStatus !== "reached") return null;
  return `${SPEND_CAP_REACHED_PREFIX}${currency(summary.dailyCapUsd)} spend cap. You can keep chatting; this is a warning, not a block.`;
}

export interface SpendSettingsAdapter {
  readonly view: SpendMeterView;
  readonly port: SpendSettingsPort;
}

export function createSpendSettingsAdapter(input: {
  readonly read: () => SpendSurfaceState;
  readonly publish: (next: SpendSurfaceState) => void;
}): SpendSettingsAdapter {
  let saveHandler: (() => void) | undefined;
  let disposed = false;
  let lastSummary: SpendSummary | undefined;

  const renderSummary = (summary: SpendSummary, options: { readonly stale: boolean }): void => {
    if (disposed) return;
    lastSummary = summary;
    const current = input.read();
    const keepDraft = current.capDirty && Number(current.capDraft) !== summary.dailyCapUsd;
    input.publish({
      ...current,
      status: "ready",
      summary,
      stale: options.stale,
      capDraft: keepDraft ? current.capDraft : String(summary.dailyCapUsd),
      capDirty: keepDraft,
      warning: capWarningCopy(summary),
    });
  };

  return {
    view: {
      renderLoading() {
        if (disposed) return;
        input.publish({
          ...input.read(),
          status: "loading",
          summary: null,
          stale: false,
          warning: null,
        });
      },
      renderSummary,
      renderUnavailable({ hadSummary }) {
        if (disposed) return;
        if (hadSummary && lastSummary !== undefined) {
          renderSummary(lastSummary, { stale: true });
          return;
        }
        input.publish({
          ...input.read(),
          status: "unavailable",
          summary: null,
          stale: false,
          warning: null,
        });
      },
      bindSave(handler) {
        saveHandler = handler;
      },
      readDailyCapUsd() {
        return Number(input.read().capDraft);
      },
      setSaving(saving) {
        if (disposed) return;
        input.publish({ ...input.read(), saving });
      },
      showCapInputError(message) {
        if (disposed) return;
        input.publish({ ...input.read(), capError: message });
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        saveHandler = undefined;
        input.publish({ ...input.read(), warning: null });
      },
    },
    port: {
      changeCap(value) {
        input.publish({ ...input.read(), capDraft: value, capDirty: true });
      },
      save() {
        saveHandler?.();
      },
    },
  };
}
