import type { StateCreator } from "zustand";
import type { EnduragentState } from "./store.js";

export type SessionTimezoneNoticeState =
  | { readonly status: "hidden" }
  | {
      readonly status: "shown" | "answering" | "failed";
      readonly stored: string;
      readonly host: string;
    };

export interface SessionTimezoneActions {
  keepStored(): void;
  useHost(): void;
}

export const HIDDEN_SESSION_TIMEZONE_NOTICE: SessionTimezoneNoticeState = Object.freeze({
  status: "hidden" as const,
});

export interface SessionTimezoneSlice {
  readonly sessionTimezoneNotice: SessionTimezoneNoticeState;
  readonly sessionTimezoneActions: SessionTimezoneActions | null;
  setSessionTimezoneNotice: (next: SessionTimezoneNoticeState) => void;
  bindSessionTimezoneActions: (actions: SessionTimezoneActions | null) => void;
}

export const createSessionTimezoneSlice: StateCreator<
  EnduragentState,
  [],
  [],
  SessionTimezoneSlice
> = (set) => ({
  sessionTimezoneNotice: HIDDEN_SESSION_TIMEZONE_NOTICE,
  sessionTimezoneActions: null,
  setSessionTimezoneNotice(next) {
    set({ sessionTimezoneNotice: next });
  },
  bindSessionTimezoneActions(actions) {
    set({ sessionTimezoneActions: actions });
  },
});
