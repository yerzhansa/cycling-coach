export type DesktopUpdateState =
  | { readonly status: "disabled" | "idle" | "checking" | "current" }
  | { readonly status: "downloading" | "downloaded" | "installing"; readonly version: string }
  | { readonly status: "failed"; readonly stage: "check" | "download" };

export interface DesktopUpdateBridge {
  getUpdateState(): Promise<DesktopUpdateState>;
  checkForUpdates(): Promise<DesktopUpdateState>;
  restartToUpdate(): Promise<DesktopUpdateState>;
  onUpdateState(listener: (state: DesktopUpdateState) => void): () => void;
}

export interface DesktopUpdateView {
  bind(handler: () => void): void;
  render(state: DesktopUpdateState, options?: { readonly actionDisabled?: boolean }): void;
  dispose(): void;
}

export function createDesktopUpdateController(input: {
  readonly bridge: DesktopUpdateBridge;
  readonly view: DesktopUpdateView;
}): { readonly start: () => Promise<void>; readonly dispose: () => void } {
  let disposed = false;
  let state: DesktopUpdateState = { status: "idle" };
  let active: Promise<void> | undefined;
  let revision = 0;
  const renderCurrent = (): void => {
    if (!disposed) {
      if (active === undefined) input.view.render(state);
      else input.view.render(state, { actionDisabled: true });
    }
  };
  const render = (next: DesktopUpdateState): void => {
    if (disposed) return;
    state = next;
    revision += 1;
    renderCurrent();
  };
  const unsubscribe = input.bridge.onUpdateState(render);

  const activate = (): void => {
    if (
      disposed ||
      active !== undefined ||
      ["disabled", "checking", "downloading", "installing"].includes(state.status)
    ) {
      return;
    }
    const restarting = state.status === "downloaded";
    const action = restarting ? input.bridge.restartToUpdate : input.bridge.checkForUpdates;
    const before = revision;
    const pending = Promise.resolve()
      .then(() => action.call(input.bridge))
      .then(
        (next) => {
          if (!disposed && revision === before) render(next);
        },
        () => {
          if (!disposed && revision === before && !restarting) {
            render({
              status: "failed",
              stage: state.status === "downloading" ? "download" : "check",
            });
          }
        },
      )
      .finally(() => {
        if (active === pending) {
          active = undefined;
          renderCurrent();
        }
      });
    active = pending;
    renderCurrent();
  };
  input.view.bind(activate);

  return {
    async start() {
      if (disposed) return;
      const before = revision;
      try {
        const initial = await input.bridge.getUpdateState();
        if (!disposed && revision === before) render(initial);
      } catch {
        if (!disposed && revision === before) render({ status: "failed", stage: "check" });
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      input.view.dispose();
    },
  };
}
