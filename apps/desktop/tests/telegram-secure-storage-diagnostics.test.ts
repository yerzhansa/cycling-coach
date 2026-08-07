import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createTelegramSecureStorageDiagnostics,
  emitTelegramSecureStorageFailure,
  TELEGRAM_SECURE_STORAGE_REASONS,
  TELEGRAM_SECURE_STORAGE_STAGES,
} from "../src/main/telegram-secure-storage-diagnostics.js";

describe("Telegram secure-storage diagnostics", () => {
  it("writes only the closed stage and reason vocabulary", () => {
    expect(TELEGRAM_SECURE_STORAGE_STAGES).toEqual([
      "namespace",
      "encryption-availability",
      "profile-atomic-write",
      "desired-state-write",
      "daemon-apply",
    ]);
    expect(TELEGRAM_SECURE_STORAGE_REASONS).toEqual([
      "encryption-unavailable",
      "unsafe-backend",
      "storage-failed",
      "storage-uncertain",
      "control-unavailable",
      "control-uncertain",
    ]);
    const write = vi.fn();
    const observe = createTelegramSecureStorageDiagnostics(write);

    observe({
      stage: "encryption-availability",
      reason: "unsafe-backend",
      token: "must-not-cross",
      path: "/private/credential",
      error: "private backend detail",
    } as never);

    expect(write).toHaveBeenCalledWith(
      "desktop-telegram-secure-storage-failure encryption-availability unsafe-backend\n",
    );
    expect(JSON.stringify(write.mock.calls)).not.toMatch(
      /must-not-cross|private\/credential|private backend detail/u,
    );
  });

  it("isolates asynchronously rejecting observers", async () => {
    const observe = vi.fn(async () => {
      throw new TypeError("private observer failure");
    });

    expect(() =>
      emitTelegramSecureStorageFailure(observe, {
        stage: "daemon-apply",
        reason: "control-uncertain",
      }),
    ).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(observe).toHaveBeenCalledWith({
      stage: "daemon-apply",
      reason: "control-uncertain",
    });
  });

  it("wires one production diagnostic into the vault and both coordinator lifetimes", async () => {
    const source = await readFile(resolve(import.meta.dirname, "../src/main/index.ts"), "utf8");

    expect(source).toContain(
      "const telegramSecureStorageDiagnostics = createTelegramSecureStorageDiagnostics();",
    );
    expect(
      source.match(/observeSecureStorageFailure: telegramSecureStorageDiagnostics/gu),
    ).toHaveLength(3);
  });
});
