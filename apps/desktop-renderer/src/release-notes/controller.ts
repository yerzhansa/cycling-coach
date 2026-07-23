export type ReleaseNotesResult =
  | {
      readonly status: "available";
      readonly version: string;
      readonly notes: readonly string[];
      readonly releaseUrl: string;
    }
  | {
      readonly status: "unavailable";
      readonly version: string | null;
      readonly releaseUrl: string;
    };

export interface ReleaseNotesView {
  bind(handlers: {
    readonly onOpen: () => void;
    readonly onRetry: () => void;
    readonly onClose: () => void;
  }): void;
  open(): void;
  close(): void;
  renderLoading(): void;
  renderAvailable(result: Extract<ReleaseNotesResult, { readonly status: "available" }>): void;
  renderUnavailable(input: {
    readonly version: string | null;
    readonly releaseUrl: string | null;
  }): void;
  dispose(): void;
}

export interface ReleaseNotesController {
  activate(): Promise<void>;
  dispose(): void;
}

export function createReleaseNotesController(input: {
  readonly request: () => Promise<ReleaseNotesResult>;
  readonly view: ReleaseNotesView;
}): ReleaseNotesController {
  let disposed = false;
  let active: Promise<void> | undefined;

  const activate = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    input.view.open();
    if (active !== undefined) return active;
    input.view.renderLoading();
    const pending = Promise.resolve()
      .then(() => input.request())
      .then(
        (result) => {
          if (disposed) return;
          if (result.status === "available") input.view.renderAvailable(result);
          else
            input.view.renderUnavailable({
              version: result.version,
              releaseUrl: result.releaseUrl,
            });
        },
        () => {
          if (!disposed) input.view.renderUnavailable({ version: null, releaseUrl: null });
        },
      )
      .finally(() => {
        if (active === pending) active = undefined;
      });
    active = pending;
    return pending;
  };

  input.view.bind({
    onOpen: () => void activate(),
    onRetry: () => void activate(),
    onClose: () => input.view.close(),
  });

  return {
    activate,
    dispose() {
      if (disposed) return;
      disposed = true;
      input.view.dispose();
    },
  };
}
