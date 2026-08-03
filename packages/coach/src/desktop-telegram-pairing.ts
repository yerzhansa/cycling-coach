import { randomBytes } from "node:crypto";
import type { TelegramPairingState } from "@enduragent/coach-contract";

export type DesktopPrimaryOperatorClaimResult =
  | { readonly status: "claimed" | "already-primary" }
  | { readonly status: "refused"; readonly reason: string };

export interface DesktopTelegramPairingCoordinator {
  getState(): TelegramPairingState;
  begin(): TelegramPairingState;
  cancel(): TelegramPairingState;
  reset(): TelegramPairingState;
  consumePrivateMessage(input: {
    readonly senderId: string;
    readonly messageText: string;
  }): boolean;
}

export interface CreateDesktopTelegramPairingInput {
  readonly claimPrimaryOperator: (senderId: string) => DesktopPrimaryOperatorClaimResult;
  readonly hasPrimaryOperator: () => boolean;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly now?: () => number;
}

const PAIRING_WINDOW_MS = 60_000;
const UNPAIRED = Object.freeze({ state: "unpaired" } as const);
const PAIRED = Object.freeze({ state: "paired" } as const);

export function createDesktopTelegramPairing(
  input: CreateDesktopTelegramPairingInput,
): DesktopTelegramPairingCoordinator {
  const now = input.now ?? Date.now;
  const bytes = input.randomBytes ?? randomBytes;
  let state: TelegramPairingState;
  try {
    state = input.hasPrimaryOperator() ? PAIRED : UNPAIRED;
  } catch {
    state = { state: "failed", errorCode: "telegram-pairing-storage-failed" };
  }
  let active: { readonly code: string; readonly expiresAtMs: number } | undefined;
  let consumed: { readonly code: string; readonly expiresAtMs: number } | undefined;

  const expire = (): void => {
    if (consumed !== undefined && now() >= consumed.expiresAtMs) consumed = undefined;
    if (active === undefined || now() < active.expiresAtMs) return;
    active = undefined;
    state = { state: "expired" };
  };

  return {
    getState() {
      expire();
      return state;
    },

    begin() {
      try {
        expire();
        let code: string | undefined;
        for (let attempt = 0; attempt < 8 && code === undefined; attempt++) {
          const generated = bytes(3);
          if (generated.byteLength !== 3) throw new TypeError("invalid pairing entropy");
          const candidate = Array.from(generated, (value) => value.toString(16).padStart(2, "0"))
            .join("")
            .toUpperCase();
          if (candidate !== consumed?.code) code = candidate;
        }
        if (code === undefined) throw new TypeError("pairing entropy repeated");
        const expiresAtMs = now() + PAIRING_WINDOW_MS;
        active = { code, expiresAtMs };
        state = { state: "awaiting-code", code, expiresAt: new Date(expiresAtMs).toISOString() };
      } catch {
        active = undefined;
        state = { state: "failed", errorCode: "telegram-pairing-unavailable" };
      }
      return state;
    },

    cancel() {
      active = undefined;
      if (state.state !== "paired") state = UNPAIRED;
      return state;
    },

    reset() {
      active = undefined;
      consumed = undefined;
      state = UNPAIRED;
      return state;
    },

    consumePrivateMessage({ senderId, messageText }) {
      const candidate = messageText.trim();
      expire();
      if (consumed !== undefined && candidate === consumed.code) return true;
      if (active === undefined || candidate !== active.code) return false;

      const claimedCode = active.code;
      const expiresAtMs = active.expiresAtMs;
      active = undefined;
      consumed = { code: claimedCode, expiresAtMs };
      try {
        const claim = input.claimPrimaryOperator(senderId);
        state =
          claim.status === "claimed" || claim.status === "already-primary"
            ? PAIRED
            : { state: "failed", errorCode: "telegram-pairing-refused" };
      } catch {
        state = { state: "failed", errorCode: "telegram-pairing-storage-failed" };
      }
      return true;
    },
  };
}
