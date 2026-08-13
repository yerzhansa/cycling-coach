import type { DesktopCoachClientProvider } from "./coach-client.js";
import {
  HIDDEN_SESSION_TIMEZONE_NOTICE,
  type SessionTimezoneActions,
  type SessionTimezoneNoticeState,
} from "./state/session-timezone-slice.js";

export interface SessionTimezoneBridge {
  sessionTimezoneNotice(): Promise<DesktopSessionTimezoneNotice>;
}

export interface SessionTimezoneNoticeController extends SessionTimezoneActions {
  start(): Promise<void>;
  state(): SessionTimezoneNoticeState;
  dispose(): void;
}

export function createSessionTimezoneNoticeController(input: {
  readonly bridge: SessionTimezoneBridge;
  readonly clients: DesktopCoachClientProvider;
  readonly chooseMode: (mode: DesktopSessionTimezoneMode) => Promise<boolean>;
  readonly view: { render(state: SessionTimezoneNoticeState): void };
}): SessionTimezoneNoticeController {
  let current: SessionTimezoneNoticeState = HIDDEN_SESSION_TIMEZONE_NOTICE;
  let disposed = false;
  let answering = false;

  const render = (next: SessionTimezoneNoticeState): void => {
    current = next;
    input.view.render(next);
  };

  const answer = async (
    mode: DesktopSessionTimezoneMode,
    adopt: string | null,
  ): Promise<void> => {
    if (disposed || answering) return;
    if (current.status !== "shown" && current.status !== "failed") return;
    const shown = current;
    answering = true;
    render({ status: "answering", stored: shown.stored, host: shown.host });
    try {
      if (adopt !== null) {
        const client = await input.clients.getClient();
        const result = await client.call("configureRuntime", { session: { timezone: adopt } });
        if (result.status !== "applied" || result.applied.session !== true) {
          throw new TypeError();
        }
      }
      const chosen = await input.chooseMode(mode);
      if (disposed) return;
      if (!chosen) {
        render({ status: "failed", stored: shown.stored, host: shown.host });
        return;
      }
      render(HIDDEN_SESSION_TIMEZONE_NOTICE);
    } catch {
      if (!disposed) render({ status: "failed", stored: shown.stored, host: shown.host });
    } finally {
      answering = false;
    }
  };

  return {
    async start() {
      if (disposed) return;
      let notice: DesktopSessionTimezoneNotice;
      try {
        notice = await input.bridge.sessionTimezoneNotice();
      } catch {
        return;
      }
      if (disposed || notice.status !== "reconcile") return;
      render({ status: "shown", stored: notice.stored, host: notice.host });
    },
    keepStored() {
      void answer("fixed", null);
    },
    useHost() {
      const shown = current;
      if (shown.status !== "shown" && shown.status !== "failed") return;
      void answer("follow", shown.host);
    },
    state: () => current,
    dispose() {
      disposed = true;
    },
  };
}
