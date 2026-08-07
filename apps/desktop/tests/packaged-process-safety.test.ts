import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  installTelegramAcceptanceQuitControl,
  observeTelegramAcceptanceChild,
  releaseAcceptanceStorage,
  runTelegramAcceptanceBootstrap,
  TELEGRAM_ACCEPTANCE_ACCOUNTING_NAME,
  TELEGRAM_ACCEPTANCE_QUIT_FRAME,
  telegramAcceptanceBundleTextIsClear,
  telegramAcceptanceDebuggerListenerOwner,
  telegramAcceptanceDirectExitIsClean,
  telegramAcceptanceJsonDiagnostic,
  telegramAcceptanceLaunchDiagnostic,
  telegramAcceptanceProcessTableIsClear,
  telegramAcceptanceShutdownIsProven,
} from "./fixtures/packaged-telegram/process-safety.js";

function processTable(source: string, overrides: { code?: number; stderr?: string } = {}) {
  return {
    code: overrides.code ?? 0,
    signal: null,
    stdout: Buffer.from(source),
    stderr: Buffer.from(overrides.stderr ?? ""),
  };
}

const bundleRoot = "/tmp/Enduragent Telegram Acceptance.app";

function fakeChild(pid: number | undefined) {
  const emitter = new EventEmitter();
  Object.defineProperty(emitter, "pid", { configurable: true, value: pid });
  return { child: emitter as unknown as ChildProcess, emitter };
}

describe("packaged direct-child lifecycle", () => {
  it("settles both observations without rejection when spawn fails", async () => {
    const { child, emitter } = fakeChild(undefined);
    const lifecycle = observeTelegramAcceptanceChild(child);
    const error = new Error("spawn failed");
    emitter.emit("error", error);
    await expect(lifecycle.launch).resolves.toEqual({ state: "spawn-error", error });
    await expect(lifecycle.terminal).resolves.toEqual({ state: "spawn-error", error });
  });

  it("requires spawn followed by close zero with no signal", async () => {
    const { child, emitter } = fakeChild(123);
    const lifecycle = observeTelegramAcceptanceChild(child);
    emitter.emit("spawn");
    emitter.emit("close", 0, null);
    expect(
      telegramAcceptanceDirectExitIsClean(await lifecycle.launch, await lifecycle.terminal),
    ).toBe(true);

    for (const terminal of [
      { state: "closed" as const, code: 1, signal: null },
      { state: "closed" as const, code: null, signal: "SIGTERM" as const },
      { state: "child-error" as const, error: new Error("child error") },
    ]) {
      expect(telegramAcceptanceDirectExitIsClean({ state: "spawned", pid: 123 }, terminal)).toBe(
        false,
      );
    }
  });

  it("records a post-spawn child error as an unclean terminal", async () => {
    const { child, emitter } = fakeChild(123);
    const lifecycle = observeTelegramAcceptanceChild(child);
    const error = new Error("child error");
    emitter.emit("spawn");
    emitter.emit("error", error);
    expect(await lifecycle.launch).toEqual({ state: "spawned", pid: 123 });
    expect(await lifecycle.terminal).toEqual({ state: "child-error", error });
  });

  it("retains lifecycle and output diagnostics without exposing sensitive values", () => {
    const sensitive = '123456789:line one\n"quoted"\\tail';
    const escapedSensitive = JSON.stringify(sensitive).slice(1, -1);
    const diagnostic = telegramAcceptanceLaunchDiagnostic({
      pid: 123,
      code: 1,
      signal: null,
      output: {
        stdout: `before ${sensitive} after`,
        stderr: `startup ${sensitive} failed`,
      },
      sensitiveValues: [sensitive],
    });
    expect(diagnostic).toContain("pid=123; exit=1; signal=null");
    expect(diagnostic).toContain('stdout":"before <redacted> after');
    expect(diagnostic).toContain('stderr":"startup <redacted> failed');
    expect(diagnostic).not.toContain(sensitive);
    expect(diagnostic).not.toContain(escapedSensitive);

    const keyedDiagnostic = telegramAcceptanceJsonDiagnostic(
      { [`prefix ${sensitive} suffix`]: "fixed value" },
      [sensitive],
    );
    expect(keyedDiagnostic).toContain('"prefix <redacted> suffix":"fixed value"');
    expect(keyedDiagnostic).not.toContain(sensitive);
    expect(keyedDiagnostic).not.toContain(escapedSensitive);

    expect(telegramAcceptanceJsonDiagnostic({ value: "abcdef" }, ["abc", "abcdef"])).toBe(
      '{"value":"<redacted>"}',
    );
    expect(telegramAcceptanceJsonDiagnostic({ value: "redacted" }, ["redacted"])).toBe(
      '{"value":""}',
    );
  });
});

describe("packaged application bootstrap control", () => {
  it("registers an exact, fragmented stdin quit frame before production startup", async () => {
    const input = new PassThrough();
    const quit = vi.fn();
    const importProduction = vi.fn(async () => {
      expect(input.listenerCount("data")).toBeGreaterThan(0);
      expect(input.listenerCount("end")).toBeGreaterThan(0);
    });

    const bootstrap = runTelegramAcceptanceBootstrap({
      input,
      beforeImport: () => undefined,
      importProduction,
      quit,
      report: vi.fn(),
      exit: vi.fn(),
    });
    expect(importProduction).toHaveBeenCalledOnce();

    input.write(TELEGRAM_ACCEPTANCE_QUIT_FRAME.slice(0, 7));
    expect(quit).not.toHaveBeenCalled();
    const ended = new Promise<void>((resolve) => input.once("end", resolve));
    input.end(TELEGRAM_ACCEPTANCE_QUIT_FRAME.slice(7));

    await Promise.all([bootstrap, ended]);
    expect(quit).toHaveBeenCalledOnce();
  });

  it("ignores malformed, oversized, and repeated stdin commands", async () => {
    for (const command of [
      "quit\n",
      `${TELEGRAM_ACCEPTANCE_QUIT_FRAME}again\n`,
      "x".repeat(TELEGRAM_ACCEPTANCE_QUIT_FRAME.length + 1),
    ]) {
      const input = new PassThrough();
      const quit = vi.fn();
      installTelegramAcceptanceQuitControl(input, quit);
      const ended = new Promise<void>((resolve) => input.once("end", resolve));
      input.end(command);
      await ended;
      expect(quit).not.toHaveBeenCalled();
    }
  });

  it("contains production import rejection, reports only a sanitized class, and exits nonzero", async () => {
    const input = new PassThrough();
    const secret = "/private/tmp/athlete-secret\nsecond-line";
    const error = Object.assign(new Error(`Cannot load ${secret}`), {
      code: "ERR_MODULE_NOT_FOUND",
    });
    const report = vi.fn();
    const exit = vi.fn();

    await expect(
      runTelegramAcceptanceBootstrap({
        input,
        beforeImport: () => undefined,
        importProduction: async () => Promise.reject(error),
        quit: vi.fn(),
        report,
        exit,
      }),
    ).resolves.toBeUndefined();

    expect(report).toHaveBeenCalledOnce();
    const diagnostic = String(report.mock.calls[0]?.[0]);
    expect(diagnostic).toBe(
      "packaged Desktop production startup failed; category=module-resolution",
    );
    expect(diagnostic).not.toContain(secret);
    expect(diagnostic).not.toContain("athlete-secret");
    expect(diagnostic).not.toMatch(/[\r\n]/u);
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("does not echo safe-shaped attacker-controlled failure metadata", async () => {
    const report = vi.fn();
    await runTelegramAcceptanceBootstrap({
      input: new PassThrough(),
      beforeImport: () => undefined,
      importProduction: async () =>
        Promise.reject({ name: "AthleteSecret", code: "ATHLETE_SECRET" }),
      quit: vi.fn(),
      report,
      exit: vi.fn(),
    });
    expect(report).toHaveBeenCalledWith(
      "packaged Desktop production startup failed; category=unknown",
    );
  });

  it("does not report or exit after successful production startup", async () => {
    const report = vi.fn();
    const exit = vi.fn();
    await runTelegramAcceptanceBootstrap({
      input: new PassThrough(),
      beforeImport: () => undefined,
      importProduction: async () => undefined,
      quit: vi.fn(),
      report,
      exit,
    });
    expect(report).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});

describe("packaged process-table release proof", () => {
  it("recognizes every packaged app and helper by the dependable accounting name", () => {
    expect(
      telegramAcceptanceProcessTableIsClear(
        processTable(`1 launchd\n123 ${TELEGRAM_ACCEPTANCE_ACCOUNTING_NAME}\n456 node\n`),
      ),
    ).toBe(false);
    expect(telegramAcceptanceProcessTableIsClear(processTable("1 launchd\n456 node\n"))).toBe(true);
  });

  it("fails closed on failed, diagnostic, empty, malformed, or ambiguous observations", () => {
    for (const invalid of [
      processTable("", { code: 1 }),
      processTable("1 launchd\n", { stderr: "ps: diagnostic\n" }),
      processTable(""),
      processTable("not-a-process\n"),
      processTable("1 launchd\n1 node\n"),
    ]) {
      expect(() => telegramAcceptanceProcessTableIsClear(invalid)).toThrow();
    }
  });

  it("binds a debugger listener to exactly one kernel-reported process owner", () => {
    expect(telegramAcceptanceDebuggerListenerOwner(processTable("p123\0\nf22\0\nf24\0\n"))).toBe(
      123,
    );
    expect(telegramAcceptanceDebuggerListenerOwner(processTable("", { code: 1 }))).toBeUndefined();
    for (const invalid of [
      processTable(""),
      processTable("p123\0\n"),
      processTable("p123\0\nf22\0\np456\0\nf24\0\n"),
      processTable("p123\0\nf22\0\np123\0\n"),
      processTable("p123\0\nf22\0\nf22\0\n"),
      processTable("n/tmp/socket\0\n"),
      processTable("p123\0\nf22\0\n", { stderr: "lsof: diagnostic\n" }),
    ]) {
      expect(() => telegramAcceptanceDebuggerListenerOwner(invalid)).toThrow();
    }
  });

  it("uses kernel-backed bundle text paths to catch generically named subprocesses", () => {
    expect(
      telegramAcceptanceBundleTextIsClear(
        processTable(`p123\0\nftxt\0n${bundleRoot}/Contents/MacOS/chrome_crashpad_handler\0\n`),
        bundleRoot,
      ),
    ).toBe(false);
    expect(telegramAcceptanceBundleTextIsClear(processTable("", { code: 1 }), bundleRoot)).toBe(
      true,
    );
  });

  it("fails closed on malformed or outside-bundle text-path observations", () => {
    for (const invalid of [
      processTable("", { code: 0 }),
      processTable("", { code: 2 }),
      processTable(`p123\0\nftxt\0n/usr/bin/other\0\n`),
      processTable(`p123\0\nftxt\0n${bundleRoot}/Contents/MacOS/main\0\np123\0`),
      processTable(`ftxt\0n${bundleRoot}/Contents/MacOS/main\0`),
    ]) {
      expect(() => telegramAcceptanceBundleTextIsClear(invalid, bundleRoot)).toThrow();
    }
  });

  it("permits release only after successful execution, clean direct exits, and a clear scan", () => {
    const proven = {
      executionSucceeded: true,
      directApplicationsExitedCleanly: true,
      processTableClear: true,
    };
    expect(telegramAcceptanceShutdownIsProven(proven)).toBe(true);
    for (const key of Object.keys(proven) as (keyof typeof proven)[]) {
      expect(telegramAcceptanceShutdownIsProven({ ...proven, [key]: false })).toBe(false);
    }
  });
});

describe("packaged storage release", () => {
  it("does not restore the keychain or remove scratch while cleanup is unproven", async () => {
    for (const input of [
      { processesStopped: false, debuggerListenersClosed: true },
      { processesStopped: true, debuggerListenersClosed: false },
    ]) {
      const restoreKeychain = vi.fn(async () => true);
      const removeScratch = vi.fn(async () => undefined);
      await expect(
        releaseAcceptanceStorage({
          ...input,
          recoveryPath: "/tmp/recovery.keychain-db",
          restoreKeychain,
          removeScratch,
        }),
      ).rejects.toThrow("acceptance storage retained");
      expect(restoreKeychain).not.toHaveBeenCalled();
      expect(removeScratch).not.toHaveBeenCalled();
    }
  });

  it("does not remove scratch when keychain restoration is not proven", async () => {
    const removeScratch = vi.fn(async () => undefined);
    await expect(
      releaseAcceptanceStorage({
        processesStopped: true,
        debuggerListenersClosed: true,
        recoveryPath: "/tmp/recovery.keychain-db",
        restoreKeychain: async () => false,
        removeScratch,
      }),
    ).rejects.toThrow("acceptance keychain retained");
    expect(removeScratch).not.toHaveBeenCalled();
  });

  it("restores the keychain before removing scratch after every proof succeeds", async () => {
    const calls: string[] = [];
    await releaseAcceptanceStorage({
      processesStopped: true,
      debuggerListenersClosed: true,
      recoveryPath: "/tmp/recovery.keychain-db",
      restoreKeychain: async () => {
        calls.push("restore");
        return true;
      },
      removeScratch: async () => {
        calls.push("remove");
      },
    });
    expect(calls).toEqual(["restore", "remove"]);
  });
});
