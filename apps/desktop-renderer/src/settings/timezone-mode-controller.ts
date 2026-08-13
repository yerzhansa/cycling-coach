import {
  LOADING_SESSION_TIMEZONE_MODE,
  type SessionTimezoneModeState,
} from "../state/session-timezone-slice.js";

export interface SessionTimezoneModeBridge {
  sessionTimezoneSetting(): Promise<DesktopSessionTimezoneSetting>;
  setSessionTimezoneMode(mode: DesktopSessionTimezoneMode): Promise<boolean>;
}

export interface SessionTimezoneModeController {
  start(): Promise<void>;
  choose(mode: DesktopSessionTimezoneMode): Promise<boolean>;
  state(): SessionTimezoneModeState;
  dispose(): void;
}

function stateFromSetting(setting: DesktopSessionTimezoneSetting): SessionTimezoneModeState {
  if (setting.status === "environment-managed") {
    return { status: "environment-managed", timezone: setting.timezone };
  }
  if (setting.status === "unavailable") return { status: "unavailable" };
  return { status: "ready", mode: setting.mode, host: setting.host };
}

export function createSessionTimezoneModeController(input: {
  readonly bridge: SessionTimezoneModeBridge;
  readonly view: { render(state: SessionTimezoneModeState): void };
}): SessionTimezoneModeController {
  let current: SessionTimezoneModeState = LOADING_SESSION_TIMEZONE_MODE;
  let disposed = false;
  let choosing = false;
  let starting: Promise<void> | undefined;

  const render = (next: SessionTimezoneModeState): void => {
    current = next;
    input.view.render(next);
  };

  const load = async (): Promise<void> => {
    if (disposed) return;
    let setting: DesktopSessionTimezoneSetting;
    try {
      setting = await input.bridge.sessionTimezoneSetting();
    } catch {
      if (!disposed) render({ status: "unavailable" });
      return;
    }
    if (disposed) return;
    render(stateFromSetting(setting));
  };

  return {
    start() {
      starting = starting ?? load();
      return starting;
    },
    async choose(mode) {
      if (disposed || choosing) return false;
      if (starting !== undefined) await starting;
      if (disposed) return false;
      if (current.status === "environment-managed") return false;
      const previous =
        current.status === "ready" || current.status === "failed"
          ? { mode: current.mode, host: current.host }
          : { mode: null, host: null };
      choosing = true;
      render({ status: "saving", mode: previous.mode, host: previous.host });
      try {
        const stored = await input.bridge.setSessionTimezoneMode(mode);
        if (disposed) return stored;
        if (!stored) {
          render({ status: "failed", mode: previous.mode, host: previous.host });
          return false;
        }
        render({ status: "ready", mode, host: previous.host });
        return true;
      } catch {
        if (!disposed) render({ status: "failed", mode: previous.mode, host: previous.host });
        return false;
      } finally {
        choosing = false;
      }
    },
    state: () => current,
    dispose() {
      disposed = true;
    },
  };
}
