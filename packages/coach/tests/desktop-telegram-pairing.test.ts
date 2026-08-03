import { describe, expect, it, vi } from "vitest";
import { createDesktopTelegramPairing } from "../src/desktop-telegram-pairing.js";

describe("Desktop Telegram pairing", () => {
  it("creates one six-character uppercase hex code for exactly sixty seconds", () => {
    let now = Date.parse("1998-06-01T12:00:00.000Z");
    const pairing = createDesktopTelegramPairing({
      claimPrimaryOperator: vi.fn(() => ({ status: "claimed" })),
      hasPrimaryOperator: () => false,
      randomBytes: (size) => {
        expect(size).toBe(3);
        return Uint8Array.from([0xab, 0xcd, 0xef]);
      },
      now: () => now,
    });

    expect(pairing.getState()).toEqual({ state: "unpaired" });
    expect(pairing.begin()).toEqual({
      state: "awaiting-code",
      code: "ABCDEF",
      expiresAt: "1998-06-01T12:01:00.000Z",
    });

    now += 59_999;
    expect(pairing.getState().state).toBe("awaiting-code");
    now += 1;
    expect(pairing.getState()).toEqual({ state: "expired" });
  });

  it("accepts only an exact trimmed code and makes the first atomic claimant primary", () => {
    const claim = vi.fn((senderId: string) => ({ status: "claimed" as const, senderId }));
    const pairing = createDesktopTelegramPairing({
      claimPrimaryOperator: claim,
      hasPrimaryOperator: () => false,
      randomBytes: () => Uint8Array.from([0xab, 0xcd, 0xef]),
      now: () => 1_000,
    });
    pairing.begin();

    expect(pairing.consumePrivateMessage({ senderId: "11111", messageText: "ABCDEF extra" })).toBe(
      false,
    );
    expect(pairing.consumePrivateMessage({ senderId: "11111", messageText: "abcdef" })).toBe(false);
    expect(pairing.consumePrivateMessage({ senderId: "11111", messageText: "ABCDEF\n" })).toBe(
      true,
    );
    expect(pairing.consumePrivateMessage({ senderId: "22222", messageText: "ABCDEF" })).toBe(true);
    expect(claim).toHaveBeenCalledOnce();
    expect(claim).toHaveBeenCalledWith("11111");
    expect(pairing.getState()).toEqual({ state: "paired" });
  });

  it("keeps a consumed-code tombstone only through the original expiry", () => {
    let now = 10_000;
    const pairing = createDesktopTelegramPairing({
      claimPrimaryOperator: () => ({ status: "claimed" }),
      hasPrimaryOperator: () => false,
      randomBytes: () => Uint8Array.from([0xaa, 0xbb, 0xcc]),
      now: () => now,
    });
    pairing.begin();
    expect(pairing.consumePrivateMessage({ senderId: "11111", messageText: "AABBCC" })).toBe(true);

    now += 59_999;
    expect(pairing.consumePrivateMessage({ senderId: "22222", messageText: " AABBCC " })).toBe(
      true,
    );
    now += 1;
    expect(pairing.consumePrivateMessage({ senderId: "22222", messageText: "AABBCC" })).toBe(false);
  });

  it("reports paired immediately when a primary operator already exists", () => {
    const claim = vi.fn(() => ({ status: "claimed" as const }));
    const pairing = createDesktopTelegramPairing({
      claimPrimaryOperator: claim,
      hasPrimaryOperator: () => true,
    });

    expect(pairing.getState()).toEqual({ state: "paired" });
    expect(claim).not.toHaveBeenCalled();
  });

  it("closes refused, storage, and entropy failures into contract error states", () => {
    const refused = createDesktopTelegramPairing({
      claimPrimaryOperator: () => ({ status: "refused", reason: "primary-exists" }),
      hasPrimaryOperator: () => false,
      randomBytes: () => Uint8Array.from([1, 2, 3]),
    });
    refused.begin();
    expect(refused.consumePrivateMessage({ senderId: "11111", messageText: "010203" })).toBe(true);
    expect(refused.getState()).toEqual({
      state: "failed",
      errorCode: "telegram-pairing-refused",
    });

    const storage = createDesktopTelegramPairing({
      claimPrimaryOperator() {
        throw new Error("disk unavailable");
      },
      hasPrimaryOperator: () => false,
      randomBytes: () => Uint8Array.from([1, 2, 3]),
    });
    storage.begin();
    expect(storage.consumePrivateMessage({ senderId: "11111", messageText: "010203" })).toBe(true);
    expect(storage.getState()).toEqual({
      state: "failed",
      errorCode: "telegram-pairing-storage-failed",
    });

    const unavailable = createDesktopTelegramPairing({
      claimPrimaryOperator: () => ({ status: "claimed" }),
      hasPrimaryOperator: () => false,
      randomBytes() {
        throw new Error("entropy unavailable");
      },
    });
    expect(unavailable.begin()).toEqual({
      state: "failed",
      errorCode: "telegram-pairing-unavailable",
    });
  });

  it("cancels the active code while preserving a live consumed tombstone", () => {
    const pairing = createDesktopTelegramPairing({
      claimPrimaryOperator: () => ({ status: "claimed" }),
      hasPrimaryOperator: () => false,
      randomBytes: () => Uint8Array.from([0xde, 0xad, 0xbe]),
      now: () => 1_000,
    });
    pairing.begin();
    expect(pairing.cancel()).toEqual({ state: "unpaired" });
    expect(pairing.consumePrivateMessage({ senderId: "11111", messageText: "DEADBE" })).toBe(false);

    pairing.begin();
    pairing.consumePrivateMessage({ senderId: "11111", messageText: "DEADBE" });
    expect(pairing.cancel()).toEqual({ state: "paired" });
    expect(pairing.consumePrivateMessage({ senderId: "22222", messageText: "DEADBE" })).toBe(true);
  });
});
