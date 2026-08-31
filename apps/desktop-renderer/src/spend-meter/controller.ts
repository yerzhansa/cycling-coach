import type { SpendSummary } from "@enduragent/coach-contract";
import type { DesktopCoachClientProvider } from "../coach-client";

export const SPEND_REFRESH_INTERVAL_MS = 30_000;

export interface SpendMeterView {
  renderLoading(): void;
  renderSummary(summary: SpendSummary, options: { readonly stale: boolean }): void;
  renderUnavailable(options: { readonly hadSummary: boolean }): void;
  bindSave(handler: () => void): void;
  readDailyCapUsd(): number;
  setSaving(saving: boolean): void;
  showCapInputError(message: string | null): void;
  dispose(): void;
}

export interface SpendMeterController {
  start(): void;
  refresh(): Promise<void>;
  saveDailyCap(): Promise<void>;
  dispose(): void;
}

export function createSpendMeterController(input: {
  readonly clients: DesktopCoachClientProvider;
  readonly view: SpendMeterView;
  readonly setInterval?: typeof globalThis.setInterval;
  readonly clearInterval?: typeof globalThis.clearInterval;
}): SpendMeterController {
  const schedule = input.setInterval ?? globalThis.setInterval;
  const cancel = input.clearInterval ?? globalThis.clearInterval;
  let started = false;
  let disposed = false;
  let hadSummary = false;
  let interval: ReturnType<typeof globalThis.setInterval> | undefined;
  let refreshPromise: Promise<void> | undefined;
  let savePromise: Promise<void> | undefined;
  let postSaveRefresh: Promise<void> | undefined;

  const executeRefresh = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (refreshPromise !== undefined) return refreshPromise;
    const pending = (async () => {
      try {
        const client = await input.clients.getClient();
        const summary = await client.call("getSpendSummary", {});
        if (disposed) return;
        hadSummary = true;
        input.view.renderSummary(summary, { stale: false });
      } catch {
        if (!disposed) input.view.renderUnavailable({ hadSummary });
      }
    })().finally(() => {
      if (refreshPromise === pending) refreshPromise = undefined;
    });
    refreshPromise = pending;
    return pending;
  };

  const refresh = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (savePromise === undefined) return executeRefresh();
    if (postSaveRefresh !== undefined) return postSaveRefresh;
    const activeSave = savePromise;
    const pending = activeSave
      .catch(() => {})
      .then(() => executeRefresh())
      .finally(() => {
        if (postSaveRefresh === pending) postSaveRefresh = undefined;
      });
    postSaveRefresh = pending;
    return pending;
  };

  const saveDailyCap = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (savePromise !== undefined) return savePromise;
    const dailyCapUsd = input.view.readDailyCapUsd();
    if (!Number.isFinite(dailyCapUsd) || dailyCapUsd <= 0) {
      input.view.showCapInputError("Enter a daily cap greater than $0.");
      return Promise.resolve();
    }
    input.view.showCapInputError(null);
    input.view.setSaving(true);
    const olderRefresh = refreshPromise;
    const pending = (async () => {
      try {
        await olderRefresh?.catch(() => {});
        if (disposed) return;
        const client = await input.clients.getClient();
        const summary = await client.call("setDailySpendCap", { dailyCapUsd });
        if (disposed) return;
        hadSummary = true;
        input.view.renderSummary(summary, { stale: false });
      } catch {
        if (!disposed) input.view.showCapInputError("The daily cap could not be saved.");
      } finally {
        if (!disposed) input.view.setSaving(false);
      }
    })().finally(() => {
      if (savePromise === pending) savePromise = undefined;
    });
    savePromise = pending;
    return pending;
  };

  return {
    start() {
      if (started || disposed) return;
      started = true;
      input.view.bindSave(() => void saveDailyCap());
      input.view.renderLoading();
      void refresh();
      interval = schedule(() => void refresh(), SPEND_REFRESH_INTERVAL_MS);
    },
    refresh,
    saveDailyCap,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (interval !== undefined) cancel(interval);
      interval = undefined;
      input.view.dispose();
    },
  };
}
