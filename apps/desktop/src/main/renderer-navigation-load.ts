export interface DesktopRendererNavigation<Window> {
  readonly window: Window;
  readonly url: string;
  readonly task: Promise<void>;
}

export interface DesktopRendererNavigationTracker<Window> {
  start(
    window: Window,
    url: string,
    load: () => Promise<void>,
  ): DesktopRendererNavigation<Window>;
  waitForCurrent(navigation: DesktopRendererNavigation<Window>): Promise<void>;
}

export function createDesktopRendererNavigationTracker<Window>(): DesktopRendererNavigationTracker<Window> {
  let current: DesktopRendererNavigation<Window> | undefined;

  return {
    start(window, url, load) {
      let task: Promise<void>;
      try {
        task = load();
      } catch (error) {
        task = Promise.reject(error);
      }
      const navigation = { window, url, task };
      current = navigation;
      void task.catch(() => {});
      return navigation;
    },
    async waitForCurrent(navigation) {
      let candidate = navigation;
      for (;;) {
        try {
          await candidate.task;
        } catch (error) {
          const replacement = current;
          if (
            replacement !== undefined &&
            replacement !== candidate &&
            replacement.window === candidate.window
          ) {
            candidate = replacement;
            continue;
          }
          throw error;
        }
        const replacement = current;
        if (replacement === candidate) return;
        if (replacement === undefined || replacement.window !== candidate.window) {
          throw new Error("desktop renderer navigation superseded");
        }
        candidate = replacement;
      }
    },
  };
}
