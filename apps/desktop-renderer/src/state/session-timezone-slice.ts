import type { StateCreator } from "zustand";
import type { EnduragentState } from "./store.js";

export type SessionTimezoneNoticeState =
  | { readonly status: "hidden" }
  | {
      readonly status: "shown" | "answering" | "failed";
      readonly stored: string;
      readonly host: string;
    };

export type SessionTimezoneModeState =
  | { readonly status: "loading" }
  | { readonly status: "unavailable" }
  | { readonly status: "environment-managed"; readonly timezone: string }
  | {
      readonly status: "ready" | "saving" | "failed";
      readonly mode: DesktopSessionTimezoneMode | null;
      readonly host: string | null;
    };

export interface SessionTimezoneActions {
  keepStored(): void;
  useHost(): void;
}

export interface SessionTimezoneModeActions {
  choose(mode: DesktopSessionTimezoneMode): void;
}

export const HIDDEN_SESSION_TIMEZONE_NOTICE: SessionTimezoneNoticeState = Object.freeze({
  status: "hidden" as const,
});

export const LOADING_SESSION_TIMEZONE_MODE: SessionTimezoneModeState = Object.freeze({
  status: "loading" as const,
});

export interface SessionTimezoneSlice {
  readonly sessionTimezoneNotice: SessionTimezoneNoticeState;
  readonly sessionTimezoneActions: SessionTimezoneActions | null;
  readonly sessionTimezoneMode: SessionTimezoneModeState;
  readonly sessionTimezoneModeActions: SessionTimezoneModeActions | null;
  setSessionTimezoneNotice: (next: SessionTimezoneNoticeState) => void;
  bindSessionTimezoneActions: (actions: SessionTimezoneActions | null) => void;
  setSessionTimezoneMode: (next: SessionTimezoneModeState) => void;
  bindSessionTimezoneModeActions: (actions: SessionTimezoneModeActions | null) => void;
}

export const createSessionTimezoneSlice: StateCreator<
  EnduragentState,
  [],
  [],
  SessionTimezoneSlice
> = (set) => ({
  sessionTimezoneNotice: HIDDEN_SESSION_TIMEZONE_NOTICE,
  sessionTimezoneActions: null,
  sessionTimezoneMode: LOADING_SESSION_TIMEZONE_MODE,
  sessionTimezoneModeActions: null,
  setSessionTimezoneNotice(next) {
    set({ sessionTimezoneNotice: next });
  },
  bindSessionTimezoneActions(actions) {
    set({ sessionTimezoneActions: actions });
  },
  setSessionTimezoneMode(next) {
    set({ sessionTimezoneMode: next });
  },
  bindSessionTimezoneModeActions(actions) {
    set({ sessionTimezoneModeActions: actions });
  },
});
