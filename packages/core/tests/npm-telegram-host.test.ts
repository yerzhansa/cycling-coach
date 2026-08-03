import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPairingState, saveAllowedSenders } from "../src/channels/allowed-senders.js";
import { cyclingBinary } from "./helpers/cycling-binary-fixture.js";

let dataDir: string;
let managed = false;
const install = vi.fn();

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "npm-telegram-host-"));
  managed = false;
  install.mockReset();
  vi.resetModules();
  vi.doMock("../src/updater.js", async () => {
    const actual = await vi.importActual<typeof import("../src/updater.js")>("../src/updater.js");
    return {
      ...actual,
      checkForUpdate: vi.fn(async () => ({
        current: "2026.8.1",
        latest: "2026.8.2",
        updateAvailable: true,
      })),
      getCurrentVersion: vi.fn(() => "2026.8.1"),
      isManagedDeploy: vi.fn(() => managed),
      selfUpdate: install,
    };
  });
  vi.doMock("../src/release-notes.js", () => ({
    buildWhatsNewMessage: vi.fn(async () => "release notes"),
  }));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.doUnmock("../src/updater.js");
  vi.doUnmock("../src/release-notes.js");
});

describe("createNpmTelegramHost", () => {
  it("omits operations and raw diagnostics when no Reference runtime is supplied", async () => {
    const { createNpmTelegramHost } = await import("../src/channels/npm-telegram-host.js");
    const host = createNpmTelegramHost({
      binary: cyclingBinary,
      confirmations: {
        peek: () => undefined,
        confirm: async () => ({ status: "none" as const }),
        cancel: () => "none" as const,
      },
      dataDir,
    });

    expect(host.operations).toBeUndefined();
    expect(host.diagnostics).toBeUndefined();
  });

  it("projects confirmations, sync, diagnostics, and primary-operator authorization", async () => {
    saveAllowedSenders(dataDir, () => ({
      ...defaultPairingState(),
      dmPolicy: "allowlist",
      allowFrom: ["73", "74"],
      primaryOperator: "73",
    }));
    const confirmations = {
      peek: vi.fn(() => ({ nonce: "n", summary: "Save plan" })),
      confirm: vi.fn(async () => ({ status: "expired" as const })),
      cancel: vi.fn(() => "canceled" as const),
    };
    const reference = {
      loadLatest: vi.fn(() => null),
      runSync: vi.fn(async () => ({ kind: "skipped" as const, reason: "cooldown" as const })),
      maybeRefreshIfStale: vi.fn(async () => ({ kind: "fresh" as const })),
    };
    const { createNpmTelegramHost } = await import("../src/channels/npm-telegram-host.js");
    const host = createNpmTelegramHost({
      binary: cyclingBinary,
      confirmations,
      dataDir,
      reference,
    });

    await expect(host.confirmations.peek({ chatId: "telegram:73" })).resolves.toEqual({
      nonce: "n",
      summary: "Save plan",
    });
    await expect(
      host.confirmations.confirm({ chatId: "telegram:73", nonce: "n" }),
    ).resolves.toEqual({ status: "expired" });
    await expect(host.confirmations.cancel({ chatId: "telegram:73", nonce: "n" })).resolves.toBe(
      "canceled",
    );
    expect(confirmations.peek).toHaveBeenCalledWith("telegram:73");
    expect(confirmations.confirm).toHaveBeenCalledWith("telegram:73", "n");
    expect(confirmations.cancel).toHaveBeenCalledWith("telegram:73", "n");

    await expect(host.operations?.resolveTurnContext()).resolves.toEqual({
      resolvedCs: null,
      referenceProvenance: undefined,
    });
    await expect(host.operations?.sync({ chatId: "telegram:73" })).resolves.toEqual({
      text: expect.stringContaining("Just synced"),
    });
    expect(reference.runSync).toHaveBeenCalledWith({ chatId: "telegram:73" });
    await expect(host.diagnostics?.rawSnapshot({})).resolves.toMatchObject({ kind: "chunks" });
    await expect(host.authorization.isPrimaryOperator({ senderId: "73" })).resolves.toBe(true);
    await expect(host.authorization.isPrimaryOperator({ senderId: "74" })).resolves.toBe(false);
  });

  it("exposes npm install only under npm self-update policy", async () => {
    const { createNpmTelegramHost } = await import("../src/channels/npm-telegram-host.js");
    const host = createNpmTelegramHost({
      binary: cyclingBinary,
      confirmations: {
        peek: () => undefined,
        confirm: async () => ({ status: "none" as const }),
        cancel: () => "none" as const,
      },
      dataDir,
    });

    expect(host.release.updatePolicy).toBe("npm-self-update");
    if (host.release.updatePolicy !== "npm-self-update") throw new Error("expected npm policy");
    await expect(host.release.version()).resolves.toBe("Cycling Coach v2026.8.1");
    await expect(host.release.whatsNew()).resolves.toEqual({
      kind: "available",
      text: "release notes",
    });
    await expect(host.release.check()).resolves.toMatchObject({ latest: "2026.8.2" });
    await host.release.install("2026.8.2");
    expect(install).toHaveBeenCalledWith("cycling-coach", "2026.8.2");
  });

  it("makes managed deployment policy structurally incapable of installing", async () => {
    managed = true;
    const { createNpmTelegramHost } = await import("../src/channels/npm-telegram-host.js");
    const host = createNpmTelegramHost({
      binary: cyclingBinary,
      confirmations: {
        peek: () => undefined,
        confirm: async () => ({ status: "none" as const }),
        cancel: () => "none" as const,
      },
      dataDir,
    });

    expect(host.release.updatePolicy).toBe("managed-deploy");
    expect("install" in host.release).toBe(false);
    if (host.release.updatePolicy === "npm-self-update") throw new Error("unexpected npm policy");
    await expect(host.release.updateNotice()).resolves.toContain("container image");
  });
});
