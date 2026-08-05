import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const durabilityFs = vi.hoisted(() => ({
  enabled: false,
  events: [] as string[],
  counts: {} as Record<string, number>,
  failAt: null as string | null,
  failOnOccurrence: 1,
  failures: [] as Array<{ event: string; occurrence: number }>,
  beforeEvent: null as ((event: string) => void) | null,
  linkSource: null as string | null,
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const descriptorPaths = new Map<number, string>();
  const fileName = (path: unknown): string =>
    String(path).replaceAll("\\", "/").split("/").at(-1) ?? "";
  const run = <T>(event: string, operation: () => T): T => {
    if (!durabilityFs.enabled) return operation();
    durabilityFs.events.push(event);
    const occurrence = (durabilityFs.counts[event] ?? 0) + 1;
    durabilityFs.counts[event] = occurrence;
    durabilityFs.beforeEvent?.(event);
    if (
      (durabilityFs.failAt === event && durabilityFs.failOnOccurrence === occurrence) ||
      durabilityFs.failures.some(
        (failure) => failure.event === event && failure.occurrence === occurrence,
      )
    ) {
      throw Object.assign(new Error(`synthetic durability failure at ${event}`), { code: "EIO" });
    }
    return operation();
  };
  const runFaultable = <T>(event: string, operation: () => T): T => {
    if (!durabilityFs.enabled) return operation();
    const occurrence = (durabilityFs.counts[event] ?? 0) + 1;
    durabilityFs.counts[event] = occurrence;
    durabilityFs.beforeEvent?.(event);
    if (
      (durabilityFs.failAt === event && durabilityFs.failOnOccurrence === occurrence) ||
      durabilityFs.failures.some(
        (failure) => failure.event === event && failure.occurrence === occurrence,
      )
    ) {
      throw Object.assign(new Error(`synthetic durability failure at ${event}`), { code: "EIO" });
    }
    return operation();
  };

  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const descriptor = Reflect.apply(actual.openSync, actual, args) as number;
      descriptorPaths.set(descriptor, String(args[0]));
      return descriptor;
    },
    closeSync: (descriptor: number) => {
      try {
        return actual.closeSync(descriptor);
      } finally {
        descriptorPaths.delete(descriptor);
      }
    },
    lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
      const name = fileName(args[0]);
      const event =
        name === ".telegram-access-reset"
          ? "lstat:reset-marker"
          : name === "allowed-senders.json"
            ? "lstat:allowlist"
            : "lstat:file";
      return runFaultable(event, () => Reflect.apply(actual.lstatSync, actual, args));
    },
    linkSync: (...args: Parameters<typeof actual.linkSync>) => {
      const event = fileName(args[1]) === ".allowed-senders.lock" ? "link:lock" : "link:file";
      durabilityFs.linkSource = String(args[0]);
      return runFaultable(event, () => Reflect.apply(actual.linkSync, actual, args));
    },
    fsyncSync: (descriptor: number) => {
      const path = descriptorPaths.get(descriptor) ?? "unknown";
      if (fileName(path).startsWith(".allowed-senders.lock.tmp.")) {
        return runFaultable("fsync:lock-temp", () => actual.fsyncSync(descriptor));
      }
      const event = actual.fstatSync(descriptor).isDirectory()
        ? "fsync:directory"
        : fileName(path) === ".telegram-access-reset"
          ? "fsync:reset-marker"
          : fileName(path) === "allowed-senders.json.tmp"
            ? "fsync:allowlist-temp"
            : "fsync:file";
      return run(event, () => actual.fsyncSync(descriptor));
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      const event =
        fileName(args[1]) === "allowed-senders.json" ? "rename:allowlist" : "rename:file";
      return run(event, () => Reflect.apply(actual.renameSync, actual, args));
    },
    unlinkSync: (...args: Parameters<typeof actual.unlinkSync>) => {
      const event =
        fileName(args[0]) === ".telegram-access-reset" ? "unlink:reset-marker" : "unlink:file";
      return event === "unlink:reset-marker"
        ? run(event, () => Reflect.apply(actual.unlinkSync, actual, args))
        : Reflect.apply(actual.unlinkSync, actual, args);
    },
  };
});

import {
  AllowedSendersCommitUncertainError,
  AllowedSendersRecoveryRequiredError,
  LockfileContentionError,
  loadAllowedSenders,
  loadAllowedSendersFromFile,
  saveAllowedSenders,
  defaultPairingState,
  addSender,
  addSecondarySender,
  bindDesktopTelegramAccess,
  claimPrimaryOperator,
  listDesktopAllowedSenders,
  removeSender,
  removeSecondarySender,
  resetDesktopAllowedSenders,
  listSenders,
  readKnownSessions,
  type AllowedSenders,
} from "../src/channels/allowed-senders.js";

let dataDir: string;
const ENV_KEYS = ["CYCLING_COACH_OPERATOR_ID", "CYCLING_COACH_DM_POLICY"];
let savedEnv: Record<string, string | undefined>;

function traceDurability(failAt: string | null = null, failOnOccurrence = 1): void {
  durabilityFs.enabled = true;
  durabilityFs.events = [];
  durabilityFs.counts = {};
  durabilityFs.failAt = failAt;
  durabilityFs.failOnOccurrence = failOnOccurrence;
  durabilityFs.failures = [];
  durabilityFs.beforeEvent = null;
  durabilityFs.linkSource = null;
}

function traceDurabilityFailures(failures: Array<{ event: string; occurrence: number }>): void {
  traceDurability();
  durabilityFs.failures = failures;
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "cc-allowlist-"));
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  durabilityFs.enabled = false;
  durabilityFs.events = [];
  durabilityFs.counts = {};
  durabilityFs.failAt = null;
  durabilityFs.failOnOccurrence = 1;
  durabilityFs.failures = [];
  durabilityFs.beforeEvent = null;
  durabilityFs.linkSource = null;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  durabilityFs.enabled = false;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("loadAllowedSenders — defaults", () => {
  it("returns default-pairing state when no file and no env-var (fresh install)", () => {
    const result = loadAllowedSenders(dataDir);
    expect(result).toEqual(defaultPairingState());
    expect(result.dmPolicy).toBe("pairing");
    expect(result.allowFrom).toEqual([]);
    expect(result.primaryOperator).toBeNull();
    expect(result.version).toBe(1);
    expect(result.capturedAt).toBeNull();
    expect(result.addedAt).toEqual({});
  });

  it("keeps the Desktop file-only view in pairing mode when npm environment overrides are set", () => {
    process.env.CYCLING_COACH_OPERATOR_ID = "12345";
    process.env.CYCLING_COACH_DM_POLICY = "open";

    expect(loadAllowedSenders(dataDir).dmPolicy).toBe("open");
    expect(loadAllowedSendersFromFile(dataDir)).toEqual(defaultPairingState());
  });
});

describe("loadAllowedSenders — CYCLING_COACH_OPERATOR_ID env-var", () => {
  it("CYCLING_COACH_OPERATOR_ID=12345 → allowlist mode with single operator", () => {
    process.env.CYCLING_COACH_OPERATOR_ID = "12345";
    const result = loadAllowedSenders(dataDir);
    expect(result.dmPolicy).toBe("allowlist");
    expect(result.allowFrom).toEqual(["12345"]);
    expect(result.primaryOperator).toBe("12345");
  });

  it("=0 (leading zero) → rejected, falls through to default + log", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.CYCLING_COACH_OPERATOR_ID = "0";
    const result = loadAllowedSenders(dataDir);
    expect(result).toEqual(defaultPairingState());
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("[security]"));
    errSpy.mockRestore();
  });

  it("=abc (non-numeric) → rejected, falls through to default", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.CYCLING_COACH_OPERATOR_ID = "abc";
    const result = loadAllowedSenders(dataDir);
    expect(result).toEqual(defaultPairingState());
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("= (empty) → ignored silently, falls through to default", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.CYCLING_COACH_OPERATOR_ID = "";
    const result = loadAllowedSenders(dataDir);
    expect(result).toEqual(defaultPairingState());
    expect(errSpy).not.toHaveBeenCalled(); // empty is "unset", no warn
    errSpy.mockRestore();
  });

  it("=1 (single digit, fails ≥2-digit rule) → rejected", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.CYCLING_COACH_OPERATOR_ID = "1";
    const result = loadAllowedSenders(dataDir);
    expect(result).toEqual(defaultPairingState());
  });
});

describe("loadAllowedSenders — file precedence", () => {
  it("file present beats env-var (file > env > default)", () => {
    process.env.CYCLING_COACH_OPERATOR_ID = "99999";
    writeFileSync(
      join(dataDir, "allowed-senders.json"),
      JSON.stringify({
        version: 1,
        dmPolicy: "allowlist",
        allowFrom: ["12345"],
        primaryOperator: "12345",
        capturedAt: "2026-05-09T10:00:00.000Z",
        addedAt: { "12345": "2026-05-09T10:00:00.000Z" },
      }),
    );
    const result = loadAllowedSenders(dataDir);
    expect(result.dmPolicy).toBe("allowlist");
    expect(result.allowFrom).toEqual(["12345"]);
    expect(result.primaryOperator).toBe("12345");
    expect(result.capturedAt).toBe("2026-05-09T10:00:00.000Z");
  });
});

describe("loadAllowedSenders — schema validation", () => {
  function writeRaw(content: string): void {
    writeFileSync(join(dataDir, "allowed-senders.json"), content);
  }

  it("malformed JSON → default-pairing, log to stderr (does NOT throw)", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    writeRaw("{not valid json");
    const result = loadAllowedSenders(dataDir);
    expect(result).toEqual(defaultPairingState());
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("[security]"));
    errSpy.mockRestore();
  });

  it("future version (version: 99) → default-pairing + log", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    writeRaw(
      JSON.stringify({
        version: 99,
        dmPolicy: "allowlist",
        allowFrom: ["12345"],
        primaryOperator: "12345",
      }),
    );
    const result = loadAllowedSenders(dataDir);
    expect(result).toEqual(defaultPairingState());
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("version"));
    errSpy.mockRestore();
  });

  it("invalid dmPolicy → default-pairing + log", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    writeRaw(
      JSON.stringify({
        version: 1,
        dmPolicy: "totally-not-a-policy",
        allowFrom: ["12345"],
      }),
    );
    const result = loadAllowedSenders(dataDir);
    expect(result.dmPolicy).toBe("pairing");
    expect(result.allowFrom).toEqual([]);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("dmPolicy"));
    errSpy.mockRestore();
  });

  it('S8: dmPolicy "open" from file is rejected → default-pairing (env-var-only)', () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    writeRaw(
      JSON.stringify({
        version: 1,
        dmPolicy: "open",
        allowFrom: [],
      }),
    );
    const result = loadAllowedSenders(dataDir);
    expect(result.dmPolicy).toBe("pairing");
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("dmPolicy"));
    errSpy.mockRestore();
  });

  it("missing dmPolicy → default-pairing", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    writeRaw(JSON.stringify({ version: 1, allowFrom: ["12345"] }));
    const result = loadAllowedSenders(dataDir);
    expect(result.dmPolicy).toBe("pairing");
  });

  it("S2: allowFrom number entries coerced to strings", () => {
    writeRaw(
      JSON.stringify({
        version: 1,
        dmPolicy: "allowlist",
        allowFrom: [12345],
        primaryOperator: "12345",
      }),
    );
    const result = loadAllowedSenders(dataDir);
    expect(result.allowFrom).toEqual(["12345"]);
  });

  it("S2: allowFrom not an array → fall back to pairing", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    writeRaw(
      JSON.stringify({
        version: 1,
        dmPolicy: "allowlist",
        allowFrom: "12345",
      }),
    );
    const result = loadAllowedSenders(dataDir);
    expect(result.dmPolicy).toBe("pairing");
    expect(result.allowFrom).toEqual([]);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("allowFrom"));
    errSpy.mockRestore();
  });

  it("S2: allowFrom invalid items filtered, valid items kept", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    writeRaw(
      JSON.stringify({
        version: 1,
        dmPolicy: "allowlist",
        allowFrom: ["abc", "0", "12345", null, "1", "67890"],
        primaryOperator: "12345",
      }),
    );
    const result = loadAllowedSenders(dataDir);
    expect(result.dmPolicy).toBe("allowlist");
    expect(result.allowFrom).toEqual(["12345", "67890"]);
    // Per-dropped-item warning expected for each of: "abc", "0", null, "1"
    expect(errSpy.mock.calls.length).toBeGreaterThanOrEqual(4);
    errSpy.mockRestore();
  });

  it("S2: allowFrom empty after filtering AND allowlist mode → fall back to pairing", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    writeRaw(
      JSON.stringify({
        version: 1,
        dmPolicy: "allowlist",
        allowFrom: ["abc", "0"],
      }),
    );
    const result = loadAllowedSenders(dataDir);
    expect(result.dmPolicy).toBe("pairing");
    expect(result.allowFrom).toEqual([]);
  });

  it("forward-compat: unknown top-level fields preserved on load", () => {
    writeRaw(
      JSON.stringify({
        version: 1,
        dmPolicy: "allowlist",
        allowFrom: ["12345"],
        primaryOperator: "12345",
        capturedAt: null,
        addedAt: {},
        // Hypothetical future fields:
        lastUsedAt: { "12345": "2026-05-09T10:00:00.000Z" },
        provenance: "wizard",
      }),
    );
    const result = loadAllowedSenders(dataDir);
    expect(result.lastUsedAt).toEqual({ "12345": "2026-05-09T10:00:00.000Z" });
    expect(result.provenance).toBe("wizard");
  });
});

describe("saveAllowedSenders — transformer pattern, round-trip", () => {
  it("transformer receives null on first save; resulting state is loadable", () => {
    const seenCurrent: Array<unknown> = [];
    const saved = saveAllowedSenders(dataDir, (current) => {
      seenCurrent.push(current);
      return {
        ...defaultPairingState(),
        dmPolicy: "allowlist",
        allowFrom: ["12345"],
        primaryOperator: "12345",
        capturedAt: "2026-05-09T10:00:00.000Z",
        addedAt: { "12345": "2026-05-09T10:00:00.000Z" },
      };
    });
    expect(seenCurrent).toEqual([null]);
    expect(saved.dmPolicy).toBe("allowlist");
    expect(saved.allowFrom).toEqual(["12345"]);

    const reloaded = loadAllowedSenders(dataDir);
    expect(reloaded.dmPolicy).toBe("allowlist");
    expect(reloaded.allowFrom).toEqual(["12345"]);
    expect(reloaded.primaryOperator).toBe("12345");
    expect(reloaded.capturedAt).toBe("2026-05-09T10:00:00.000Z");
    expect(reloaded.addedAt).toEqual({ "12345": "2026-05-09T10:00:00.000Z" });
  });

  it("transformer receives current state on second save (read happens inside save)", () => {
    saveAllowedSenders(dataDir, () => ({
      ...defaultPairingState(),
      dmPolicy: "allowlist",
      allowFrom: ["12345"],
      primaryOperator: "12345",
    }));
    const seen: Array<unknown> = [];
    saveAllowedSenders(dataDir, (current) => {
      seen.push(current);
      return {
        ...(current as AllowedSenders),
        allowFrom: [...(current as AllowedSenders).allowFrom, "67890"],
      };
    });
    expect(seen).toHaveLength(1);
    const seenState = seen[0] as AllowedSenders;
    expect(seenState.dmPolicy).toBe("allowlist");
    expect(seenState.allowFrom).toEqual(["12345"]);
    const reloaded = loadAllowedSenders(dataDir);
    expect(reloaded.allowFrom).toEqual(["12345", "67890"]);
  });

  it("forward-compat: round-trip through saveAllowedSenders preserves unknown top-level fields", () => {
    saveAllowedSenders(
      dataDir,
      () =>
        ({
          ...defaultPairingState(),
          dmPolicy: "allowlist",
          allowFrom: ["12345"],
          primaryOperator: "12345",
          lastUsedAt: { "12345": "2026-05-09T10:00:00.000Z" },
        }) as AllowedSenders,
    );
    saveAllowedSenders(dataDir, (current) => ({
      ...(current as AllowedSenders),
      allowFrom: [...(current as AllowedSenders).allowFrom, "67890"],
    }));
    const reloaded = loadAllowedSenders(dataDir);
    expect(reloaded.lastUsedAt).toEqual({ "12345": "2026-05-09T10:00:00.000Z" });
    expect(reloaded.allowFrom).toEqual(["12345", "67890"]);
  });
});

describe("addSender / removeSender — validation and lifecycle", () => {
  it('addSender("abc") throws (non-numeric)', () => {
    expect(() => addSender(dataDir, "abc")).toThrow(/positive integer/);
  });

  it('addSender("0") throws (leading-zero rejected)', () => {
    expect(() => addSender(dataDir, "0")).toThrow(/positive integer/);
  });

  it('addSender("1") throws (single-digit rejected by ^[1-9]\\d+$)', () => {
    expect(() => addSender(dataDir, "1")).toThrow(/positive integer/);
  });

  it('addSender("12345") then removeSender("12345") cycles dmPolicy: pairing → allowlist → pairing', () => {
    expect(loadAllowedSenders(dataDir).dmPolicy).toBe("pairing");

    addSender(dataDir, "12345");
    const afterAdd = loadAllowedSenders(dataDir);
    expect(afterAdd.dmPolicy).toBe("allowlist");
    expect(afterAdd.allowFrom).toEqual(["12345"]);
    expect(afterAdd.primaryOperator).toBe("12345");
    expect(afterAdd.addedAt["12345"]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

    removeSender(dataDir, "12345");
    const afterRemove = loadAllowedSenders(dataDir);
    expect(afterRemove.dmPolicy).toBe("pairing");
    expect(afterRemove.allowFrom).toEqual([]);
    expect(afterRemove.primaryOperator).toBeNull();
    expect(afterRemove.addedAt["12345"]).toBeUndefined();
  });

  it("addSender is idempotent — re-adding the same id is a no-op for allowFrom", () => {
    addSender(dataDir, "12345");
    addSender(dataDir, "12345");
    const result = loadAllowedSenders(dataDir);
    expect(result.allowFrom).toEqual(["12345"]);
  });

  it("addSender preserves existing allowFrom (Set-union); does not change primaryOperator if already set", () => {
    addSender(dataDir, "12345");
    addSender(dataDir, "67890");
    const result = loadAllowedSenders(dataDir);
    expect(result.allowFrom).toEqual(["12345", "67890"]);
    expect(result.primaryOperator).toBe("12345"); // first sender stays primary
  });

  it("removeSender on non-allowlisted id is a no-op (does not throw)", () => {
    addSender(dataDir, "12345");
    removeSender(dataDir, "99999");
    expect(loadAllowedSenders(dataDir).allowFrom).toEqual(["12345"]);
  });

  it("removeSender of primaryOperator clears primaryOperator (other entries promoted to no-primary)", () => {
    addSender(dataDir, "12345");
    addSender(dataDir, "67890");
    removeSender(dataDir, "12345");
    const result = loadAllowedSenders(dataDir);
    expect(result.allowFrom).toEqual(["67890"]);
    expect(result.primaryOperator).toBeNull();
  });
});

describe("Desktop sender authority operations", () => {
  const allowedSendersPath = () => join(dataDir, "allowed-senders.json");

  it("claims the first primary atomically and returns the persisted Desktop entry", () => {
    const result = claimPrimaryOperator(dataDir, "12345");

    expect(result.status).toBe("claimed");
    if (result.status !== "claimed") throw new Error("expected a successful claim");
    expect(result.sender).toEqual({
      senderId: "12345",
      role: "primary",
      addedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    const persisted = loadAllowedSendersFromFile(dataDir);
    expect(persisted).toMatchObject({
      dmPolicy: "allowlist",
      allowFrom: ["12345"],
      primaryOperator: "12345",
      capturedAt: result.sender.addedAt,
      addedAt: { "12345": result.sender.addedAt },
    });
  });

  it("treats a repeat claim by the same sender as an idempotent no-write", () => {
    const first = claimPrimaryOperator(dataDir, "12345");
    expect(first.status).toBe("claimed");
    const bytesBefore = readFileSync(allowedSendersPath(), "utf8");

    const second = claimPrimaryOperator(dataDir, "12345");

    expect(second).toEqual({
      status: "already-primary",
      sender: first.status === "claimed" ? first.sender : undefined,
    });
    expect(readFileSync(allowedSendersPath(), "utf8")).toBe(bytesBefore);
  });

  it("refuses a different primary without changing the existing file", () => {
    claimPrimaryOperator(dataDir, "12345");
    const bytesBefore = readFileSync(allowedSendersPath(), "utf8");

    expect(claimPrimaryOperator(dataDir, "67890")).toEqual({
      status: "refused",
      reason: "primary-exists",
    });
    expect(readFileSync(allowedSendersPath(), "utf8")).toBe(bytesBefore);
  });

  it("allows only one winner when two different senders try to claim", async () => {
    const results = await Promise.all([
      Promise.resolve().then(() => claimPrimaryOperator(dataDir, "11111")),
      Promise.resolve().then(() => claimPrimaryOperator(dataDir, "22222")),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(["claimed", "refused"]);
    const state = loadAllowedSendersFromFile(dataDir);
    expect(state.allowFrom).toEqual([state.primaryOperator]);
  });

  it("refuses logically inconsistent and unreadable existing files without overwriting them", () => {
    saveAllowedSenders(dataDir, () => ({
      ...defaultPairingState(),
      allowFrom: ["12345"],
    }));
    const inconsistentBytes = readFileSync(allowedSendersPath(), "utf8");
    expect(claimPrimaryOperator(dataDir, "67890")).toEqual({
      status: "refused",
      reason: "inconsistent-state",
    });
    expect(readFileSync(allowedSendersPath(), "utf8")).toBe(inconsistentBytes);

    writeFileSync(allowedSendersPath(), "{not-json");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(claimPrimaryOperator(dataDir, "67890")).toEqual({
      status: "refused",
      reason: "inconsistent-state",
    });
    expect(readFileSync(allowedSendersPath(), "utf8")).toBe("{not-json");
    errSpy.mockRestore();
  });

  it("requires a primary before adding a secondary and does not create a state file", () => {
    expect(addSecondarySender(dataDir, "67890")).toEqual({
      status: "refused",
      reason: "primary-required",
    });
    expect(existsSync(allowedSendersPath())).toBe(false);
  });

  it("refuses the pairing claim when the allowlist path cannot be inspected", () => {
    traceDurability("lstat:allowlist");

    expect(claimPrimaryOperator(dataDir, "12345")).toEqual({
      status: "refused",
      reason: "inconsistent-state",
    });
    expect(existsSync(allowedSendersPath())).toBe(false);
  });

  it("adds a secondary without changing the primary and is idempotent", () => {
    claimPrimaryOperator(dataDir, "12345");

    const added = addSecondarySender(dataDir, "67890");
    expect(added.status).toBe("added");
    if (added.status !== "added") throw new Error("expected a successful add");
    expect(added.sender).toEqual({
      senderId: "67890",
      role: "additional",
      addedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(loadAllowedSendersFromFile(dataDir)).toMatchObject({
      allowFrom: ["12345", "67890"],
      primaryOperator: "12345",
    });
    const bytesBefore = readFileSync(allowedSendersPath(), "utf8");

    expect(addSecondarySender(dataDir, "67890")).toEqual({
      status: "already-allowed",
      sender: added.sender,
    });
    expect(readFileSync(allowedSendersPath(), "utf8")).toBe(bytesBefore);
  });

  it("never promotes through addSecondarySender, including when passed the primary id", () => {
    const claimed = claimPrimaryOperator(dataDir, "12345");
    expect(claimed.status).toBe("claimed");

    expect(addSecondarySender(dataDir, "12345")).toEqual({
      status: "already-allowed",
      sender: claimed.status === "claimed" ? claimed.sender : undefined,
    });
    expect(loadAllowedSendersFromFile(dataDir).primaryOperator).toBe("12345");
  });

  it("refuses secondary mutations when the stored primary is inconsistent", () => {
    saveAllowedSenders(dataDir, () => ({
      ...defaultPairingState(),
      dmPolicy: "allowlist",
      allowFrom: ["67890"],
      primaryOperator: "12345",
    }));
    const bytesBefore = readFileSync(allowedSendersPath(), "utf8");

    expect(addSecondarySender(dataDir, "22222")).toEqual({
      status: "refused",
      reason: "inconsistent-state",
    });
    expect(removeSecondarySender(dataDir, "67890")).toEqual({
      status: "refused",
      reason: "inconsistent-state",
    });
    expect(readFileSync(allowedSendersPath(), "utf8")).toBe(bytesBefore);
  });

  it("refuses primary removal but removes an additional sender", () => {
    claimPrimaryOperator(dataDir, "12345");
    addSecondarySender(dataDir, "67890");
    const bytesBefore = readFileSync(allowedSendersPath(), "utf8");

    expect(removeSecondarySender(dataDir, "12345")).toEqual({
      status: "refused",
      reason: "primary-removal",
    });
    expect(readFileSync(allowedSendersPath(), "utf8")).toBe(bytesBefore);
    expect(removeSecondarySender(dataDir, "67890")).toEqual({ status: "removed" });
    expect(loadAllowedSendersFromFile(dataDir)).toMatchObject({
      dmPolicy: "allowlist",
      allowFrom: ["12345"],
      primaryOperator: "12345",
    });
  });

  it("returns not-found without creating or rewriting state", () => {
    expect(removeSecondarySender(dataDir, "67890")).toEqual({ status: "not-found" });
    expect(existsSync(allowedSendersPath())).toBe(false);

    claimPrimaryOperator(dataDir, "12345");
    const bytesBefore = readFileSync(allowedSendersPath(), "utf8");
    expect(removeSecondarySender(dataDir, "67890")).toEqual({ status: "not-found" });
    expect(readFileSync(allowedSendersPath(), "utf8")).toBe(bytesBefore);
  });

  it("validates sender syntax for every Desktop mutation", () => {
    expect(() => claimPrimaryOperator(dataDir, "bad")).toThrow(/positive integer/);
    expect(() => addSecondarySender(dataDir, "01")).toThrow(/positive integer/);
    expect(() => removeSecondarySender(dataDir, "1")).toThrow(/positive integer/);
  });

  it("lists only file-backed senders with roles and optional legacy timestamps", () => {
    process.env.CYCLING_COACH_OPERATOR_ID = "99999";
    saveAllowedSenders(dataDir, () => ({
      ...defaultPairingState(),
      dmPolicy: "allowlist",
      allowFrom: ["12345", "67890"],
      primaryOperator: "12345",
      capturedAt: "2026-05-09T10:00:00.000Z",
      addedAt: { "12345": "2026-05-09T10:00:00.000Z" },
    }));

    expect(listDesktopAllowedSenders(dataDir)).toEqual([
      {
        senderId: "12345",
        role: "primary",
        addedAt: "2026-05-09T10:00:00.000Z",
      },
      { senderId: "67890", role: "additional" },
    ]);
  });

  it("does not expose an environment-only sender when no Desktop file exists", () => {
    process.env.CYCLING_COACH_OPERATOR_ID = "99999";
    expect(listDesktopAllowedSenders(dataDir)).toEqual([]);
  });

  it("binds Desktop authorization to one stable Telegram bot id", () => {
    const firstBinding = "10001";
    const replacementBinding = "20002";
    claimPrimaryOperator(dataDir, "12345");

    expect(bindDesktopTelegramAccess(dataDir, firstBinding)).toBe("reset");
    expect(listDesktopAllowedSenders(dataDir)).toEqual([]);
    expect(loadAllowedSendersFromFile(dataDir).desktopBotId).toBe(firstBinding);

    claimPrimaryOperator(dataDir, "12345");
    addSecondarySender(dataDir, "67890");
    expect(bindDesktopTelegramAccess(dataDir, firstBinding)).toBe("preserved");
    expect(listDesktopAllowedSenders(dataDir).map((sender) => sender.senderId)).toEqual([
      "12345",
      "67890",
    ]);

    expect(bindDesktopTelegramAccess(dataDir, replacementBinding)).toBe("reset");
    expect(listDesktopAllowedSenders(dataDir)).toEqual([]);
    expect(loadAllowedSendersFromFile(dataDir).desktopBotId).toBe(replacementBinding);
    expect(JSON.stringify(loadAllowedSendersFromFile(dataDir))).not.toContain("secret-token");
  });

  it("rejects malformed Desktop bot bindings before writing", () => {
    expect(() => bindDesktopTelegramAccess(dataDir, "not-a-binding")).toThrow(TypeError);
    expect(existsSync(join(dataDir, "allowed-senders.json"))).toBe(false);
  });

  it("finishes an interrupted access reset before preserving a same-token binding", () => {
    const binding = "10001";
    bindDesktopTelegramAccess(dataDir, binding);
    claimPrimaryOperator(dataDir, "12345");
    writeFileSync(join(dataDir, ".telegram-access-reset"), "reset\n", { mode: 0o600 });

    expect(bindDesktopTelegramAccess(dataDir, binding)).toBe("reset");
    expect(listDesktopAllowedSenders(dataDir)).toEqual([]);
    expect(loadAllowedSendersFromFile(dataDir)).toEqual({
      ...defaultPairingState(),
      desktopBotId: binding,
    });
    expect(existsSync(join(dataDir, ".telegram-access-reset"))).toBe(false);
  });

  it("idempotently replaces every file-backed authorization with pairing state", () => {
    claimPrimaryOperator(dataDir, "12345");
    addSecondarySender(dataDir, "67890");

    resetDesktopAllowedSenders(dataDir);
    resetDesktopAllowedSenders(dataDir);

    expect(loadAllowedSendersFromFile(dataDir)).toEqual(defaultPairingState());
    expect(listDesktopAllowedSenders(dataDir)).toEqual([]);
  });

  it("treats an unreadable access-fence marker as active on every read path", () => {
    claimPrimaryOperator(dataDir, "12345");
    traceDurability("lstat:reset-marker");

    expect(loadAllowedSenders(dataDir)).toEqual(defaultPairingState());
    traceDurability("lstat:reset-marker");
    expect(loadAllowedSendersFromFile(dataDir)).toEqual(defaultPairingState());
    traceDurability("lstat:reset-marker");
    expect(listDesktopAllowedSenders(dataDir)).toEqual([]);
  });

  it("refuses authorization-expanding writes when the access fence cannot be inspected", () => {
    traceDurability("lstat:reset-marker");
    expect(claimPrimaryOperator(dataDir, "12345")).toEqual({
      status: "refused",
      reason: "inconsistent-state",
    });

    traceDurability("lstat:reset-marker");
    expect(addSecondarySender(dataDir, "67890")).toEqual({
      status: "refused",
      reason: "inconsistent-state",
    });

    traceDurability("lstat:reset-marker");
    expect(() =>
      saveAllowedSenders(dataDir, () => ({
        ...defaultPairingState(),
        dmPolicy: "allowlist",
        allowFrom: ["12345"],
        primaryOperator: "12345",
      })),
    ).toThrow(AllowedSendersRecoveryRequiredError);
    expect(existsSync(allowedSendersPath())).toBe(false);
  });

  it("acknowledges an access reset only after every security transition is durable", () => {
    claimPrimaryOperator(dataDir, "12345");
    traceDurability();

    resetDesktopAllowedSenders(dataDir);

    expect(durabilityFs.events).toEqual([
      "fsync:reset-marker",
      "fsync:directory",
      "fsync:allowlist-temp",
      "rename:allowlist",
      "fsync:directory",
      "unlink:reset-marker",
      "fsync:directory",
    ]);
    expect(JSON.parse(readFileSync(allowedSendersPath(), "utf8"))).toEqual(defaultPairingState());
    expect(existsSync(join(dataDir, ".telegram-access-reset"))).toBe(false);
  });

  it.each([
    ["fsync:reset-marker", 1, false],
    ["fsync:directory", 1, false],
  ])(
    "does not mutate or acknowledge a reset before durable marker publication at %s occurrence %i",
    (failureEvent, failureOccurrence) => {
      claimPrimaryOperator(dataDir, "12345");
      const authorizedBytes = readFileSync(allowedSendersPath(), "utf8");
      traceDurability(failureEvent, failureOccurrence);

      expect(() => resetDesktopAllowedSenders(dataDir)).toThrow(
        `synthetic durability failure at ${failureEvent}`,
      );
      expect(readFileSync(allowedSendersPath(), "utf8")).toBe(authorizedBytes);
    },
  );

  it.each([
    ["fsync:allowlist-temp", 1, false, false],
    ["rename:allowlist", 1, false, false],
    ["fsync:directory", 2, true, true],
    ["unlink:reset-marker", 1, false, true],
    ["fsync:directory", 3, false, true],
  ])(
    "keeps a durably-started reset fail-closed when %s occurrence %i fails",
    (failureEvent, failureOccurrence, emulateLostRename, commitUncertain) => {
      claimPrimaryOperator(dataDir, "12345");
      const authorizedBytes = readFileSync(allowedSendersPath(), "utf8");
      traceDurability(failureEvent, failureOccurrence);

      expect(() => resetDesktopAllowedSenders(dataDir)).toThrow(
        commitUncertain
          ? AllowedSendersCommitUncertainError
          : `synthetic durability failure at ${failureEvent}`,
      );

      durabilityFs.enabled = false;
      if (emulateLostRename) writeFileSync(allowedSendersPath(), authorizedBytes);
      expect(loadAllowedSenders(dataDir)).toEqual(defaultPairingState());
      expect(listDesktopAllowedSenders(dataDir)).toEqual([]);
    },
  );

  it("durably commits a bot-binding reset before reporting it", () => {
    claimPrimaryOperator(dataDir, "12345");
    traceDurability();

    expect(bindDesktopTelegramAccess(dataDir, "10001")).toBe("reset");

    expect(durabilityFs.events).toEqual([
      "fsync:reset-marker",
      "fsync:directory",
      "fsync:allowlist-temp",
      "rename:allowlist",
      "fsync:directory",
      "unlink:reset-marker",
      "fsync:directory",
    ]);
    expect(JSON.parse(readFileSync(allowedSendersPath(), "utf8"))).toEqual({
      ...defaultPairingState(),
      desktopBotId: "10001",
    });
  });

  it("keeps a bot-binding reset fenced when an unsynced rename is lost in a crash", () => {
    claimPrimaryOperator(dataDir, "12345");
    const authorizedBytes = readFileSync(allowedSendersPath(), "utf8");
    traceDurability("fsync:directory", 2);

    expect(() => bindDesktopTelegramAccess(dataDir, "10001")).toThrow(
      AllowedSendersCommitUncertainError,
    );
    expect(durabilityFs.events).toEqual([
      "fsync:reset-marker",
      "fsync:directory",
      "fsync:allowlist-temp",
      "rename:allowlist",
      "fsync:directory",
    ]);
    expect(existsSync(join(dataDir, ".telegram-access-reset"))).toBe(true);

    durabilityFs.enabled = false;
    writeFileSync(allowedSendersPath(), authorizedBytes);
    expect(loadAllowedSenders(dataDir)).toEqual(defaultPairingState());
    expect(bindDesktopTelegramAccess(dataDir, "10001")).toBe("reset");
    expect(loadAllowedSendersFromFile(dataDir)).toEqual({
      ...defaultPairingState(),
      desktopBotId: "10001",
    });
  });

  it("recovers a lost secondary-removal rename before an idempotent retry can succeed", () => {
    claimPrimaryOperator(dataDir, "12345");
    addSecondarySender(dataDir, "67890");
    const authorizedBytes = readFileSync(allowedSendersPath(), "utf8");
    traceDurability("fsync:directory", 2);

    expect(removeSecondarySender(dataDir, "67890")).toEqual({ status: "uncertain" });
    expect(existsSync(join(dataDir, ".telegram-access-reset"))).toBe(true);

    durabilityFs.enabled = false;
    writeFileSync(allowedSendersPath(), authorizedBytes);
    expect(loadAllowedSenders(dataDir)).toEqual(defaultPairingState());
    expect(removeSecondarySender(dataDir, "67890")).toEqual({ status: "not-found" });
    expect(loadAllowedSendersFromFile(dataDir)).toEqual(defaultPairingState());
    expect(existsSync(join(dataDir, ".telegram-access-reset"))).toBe(false);
  });

  it("recovers a lost legacy-removal rename before returning from a retry", () => {
    addSender(dataDir, "12345");
    addSender(dataDir, "67890");
    const authorizedBytes = readFileSync(allowedSendersPath(), "utf8");
    traceDurability("fsync:directory", 2);

    expect(() => removeSender(dataDir, "67890")).toThrow(AllowedSendersCommitUncertainError);
    expect(existsSync(join(dataDir, ".telegram-access-reset"))).toBe(true);

    durabilityFs.enabled = false;
    writeFileSync(allowedSendersPath(), authorizedBytes);
    removeSender(dataDir, "67890");
    expect(loadAllowedSendersFromFile(dataDir)).toEqual(defaultPairingState());
    expect(existsSync(join(dataDir, ".telegram-access-reset"))).toBe(false);
  });

  it("refuses a grant retry while the first grant has an unresolved durable fence", () => {
    claimPrimaryOperator(dataDir, "12345");
    const authorizedBytes = readFileSync(allowedSendersPath(), "utf8");
    traceDurability("fsync:directory", 2);

    expect(addSecondarySender(dataDir, "67890")).toEqual({ status: "uncertain" });

    durabilityFs.enabled = false;
    writeFileSync(allowedSendersPath(), authorizedBytes);
    expect(addSecondarySender(dataDir, "67890")).toEqual({
      status: "refused",
      reason: "inconsistent-state",
    });
    expect(() =>
      saveAllowedSenders(dataDir, (current) => current ?? defaultPairingState()),
    ).toThrow(AllowedSendersRecoveryRequiredError);
  });

  it("returns uncertain when grant cleanup and fence restoration both fail", () => {
    claimPrimaryOperator(dataDir, "12345");
    traceDurabilityFailures([
      { event: "fsync:directory", occurrence: 3 },
      { event: "fsync:reset-marker", occurrence: 2 },
    ]);

    expect(addSecondarySender(dataDir, "67890")).toEqual({ status: "uncertain" });

    durabilityFs.enabled = false;
    expect(JSON.parse(readFileSync(allowedSendersPath(), "utf8"))).toMatchObject({
      allowFrom: ["12345", "67890"],
    });
    expect(loadAllowedSenders(dataDir)).toEqual(defaultPairingState());
  });

  it("returns uncertain when a primary claim cleanup cannot restore its durable fence", () => {
    traceDurabilityFailures([
      { event: "fsync:directory", occurrence: 3 },
      { event: "fsync:reset-marker", occurrence: 2 },
    ]);

    expect(claimPrimaryOperator(dataDir, "12345")).toEqual({ status: "uncertain" });

    durabilityFs.enabled = false;
    const committedBytes = readFileSync(allowedSendersPath(), "utf8");
    expect(JSON.parse(committedBytes)).toMatchObject({
      dmPolicy: "allowlist",
      allowFrom: ["12345"],
      primaryOperator: "12345",
    });
    expect(loadAllowedSenders(dataDir)).toEqual(defaultPairingState());

    const reconstructedDir = join(dataDir, "reconstructed-process-state");
    mkdirSync(reconstructedDir, { mode: 0o700 });
    writeFileSync(join(reconstructedDir, "allowed-senders.json"), committedBytes, { mode: 0o600 });
    expect(loadAllowedSendersFromFile(reconstructedDir)).toMatchObject({
      dmPolicy: "allowlist",
      allowFrom: ["12345"],
      primaryOperator: "12345",
    });
  });

  it("still throws a definite failure before an authorization grant is committed", () => {
    claimPrimaryOperator(dataDir, "12345");
    traceDurability("fsync:allowlist-temp");

    expect(() => addSecondarySender(dataDir, "67890")).toThrow(
      "synthetic durability failure at fsync:allowlist-temp",
    );
  });

  it("preserves the bot binding across reset, re-pairing, and same-bot restart", () => {
    const binding = "10001";
    bindDesktopTelegramAccess(dataDir, binding);
    claimPrimaryOperator(dataDir, "12345");

    resetDesktopAllowedSenders(dataDir);
    expect(loadAllowedSendersFromFile(dataDir)).toEqual({
      ...defaultPairingState(),
      desktopBotId: binding,
    });
    expect(claimPrimaryOperator(dataDir, "67890").status).toBe("claimed");

    expect(bindDesktopTelegramAccess(dataDir, binding)).toBe("preserved");
    expect(listDesktopAllowedSenders(dataDir).map((sender) => sender.senderId)).toEqual(["67890"]);
  });

  it("holds the writer lock until reset state and fence removal are both durable", () => {
    claimPrimaryOperator(dataDir, "12345");
    let secondWriterError: unknown;
    traceDurability();
    durabilityFs.beforeEvent = (event) => {
      if (event !== "unlink:reset-marker") return;
      durabilityFs.beforeEvent = null;
      try {
        addSender(dataDir, "67890");
      } catch (error) {
        secondWriterError = error;
      }
    };

    resetDesktopAllowedSenders(dataDir);

    expect(secondWriterError).toBeInstanceOf(LockfileContentionError);
    expect(loadAllowedSendersFromFile(dataDir)).toEqual(defaultPairingState());
    expect(existsSync(join(dataDir, ".telegram-access-reset"))).toBe(false);
  });
});

describe("saveAllowedSenders — PID lockfile", () => {
  const lockPath = () => join(dataDir, ".allowed-senders.lock");

  it("happy path: two writes in series both succeed; lockfile is cleaned between", () => {
    addSender(dataDir, "12345");
    expect(existsSync(lockPath())).toBe(false);
    addSender(dataDir, "67890");
    expect(existsSync(lockPath())).toBe(false);
    expect(loadAllowedSenders(dataDir).allowFrom).toEqual(["12345", "67890"]);
  });

  it("contention with live PID + fresh timestamp → LockfileContentionError", async () => {
    const { LockfileContentionError } = await import("../src/channels/allowed-senders.js");
    // Plant a lockfile claiming THIS process owns it (this process IS alive).
    writeFileSync(lockPath(), `${process.pid}\n${new Date().toISOString()}`);
    expect(() => addSender(dataDir, "12345")).toThrow(LockfileContentionError);
    // Cleanup so afterEach doesn't fail
    rmSync(lockPath(), { force: true });
  });

  it("contention with a live PID does not expire when its timestamp is old", () => {
    const oldTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    writeFileSync(lockPath(), `${process.pid}\n${oldTimestamp}\nlive-owner`);

    expect(() => addSender(dataDir, "12345")).toThrow(LockfileContentionError);
    expect(readFileSync(lockPath(), "utf8")).toBe(`${process.pid}\n${oldTimestamp}\nlive-owner`);
  });

  it("does not unlink a successor that replaces this acquisition before release", () => {
    const successor = `${process.pid}\n${new Date().toISOString()}\nsuccessor-owner`;
    traceDurability();
    durabilityFs.beforeEvent = (event) => {
      if (event !== "fsync:reset-marker") return;
      durabilityFs.beforeEvent = null;
      rmSync(lockPath(), { force: true });
      writeFileSync(lockPath(), successor, { mode: 0o600 });
    };

    addSender(dataDir, "12345");

    expect(readFileSync(lockPath(), "utf8")).toBe(successor);
  });

  it("publishes a complete lock claim atomically and removes its owned temp", () => {
    let observedClaim: string | undefined;
    traceDurability();
    durabilityFs.beforeEvent = (event) => {
      if (event !== "link:lock") return;
      expect(existsSync(lockPath())).toBe(false);
      expect(durabilityFs.linkSource).not.toBeNull();
      observedClaim = readFileSync(durabilityFs.linkSource as string, "utf8");
    };

    addSender(dataDir, "12345");

    const [pid, timestamp, token] = observedClaim?.split("\n") ?? [];
    expect(pid).toBe(String(process.pid));
    expect(Date.parse(timestamp ?? "")).not.toBeNaN();
    expect(token).toMatch(/^[0-9a-f-]{36}$/u);
    expect(
      readdirSync(dataDir).filter((entry) => entry.startsWith(".allowed-senders.lock.tmp.")),
    ).toEqual([]);
  });

  it("removes its private lock temp when claim preparation fails", () => {
    traceDurability("fsync:lock-temp");

    expect(() => addSender(dataDir, "12345")).toThrow(
      "synthetic durability failure at fsync:lock-temp",
    );
    expect(existsSync(lockPath())).toBe(false);
    expect(
      readdirSync(dataDir).filter((entry) => entry.startsWith(".allowed-senders.lock.tmp.")),
    ).toEqual([]);
  });

  it("leaves authorization unchanged when reset cannot acquire its transaction lock", () => {
    claimPrimaryOperator(dataDir, "12345");
    writeFileSync(lockPath(), `${process.pid}\n${new Date().toISOString()}`);

    expect(() => resetDesktopAllowedSenders(dataDir)).toThrow(LockfileContentionError);
    expect(loadAllowedSenders(dataDir).allowFrom).toEqual(["12345"]);
    expect(listDesktopAllowedSenders(dataDir).map((sender) => sender.senderId)).toEqual(["12345"]);
    expect(existsSync(join(dataDir, ".telegram-access-reset"))).toBe(false);

    rmSync(lockPath(), { force: true });
    resetDesktopAllowedSenders(dataDir);
    expect(loadAllowedSendersFromFile(dataDir)).toEqual(defaultPairingState());
  });

  it("stale lockfile (dead PID, old timestamp) is reclaimed", () => {
    // PID 999999 is almost certainly not alive; old timestamp regardless ensures reclaim.
    const oldTs = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    writeFileSync(lockPath(), `999999\n${oldTs}`);
    addSender(dataDir, "12345");
    expect(existsSync(lockPath())).toBe(false);
    expect(loadAllowedSenders(dataDir).allowFrom).toEqual(["12345"]);
  });

  it("malformed lockfile is treated as contention and preserved", () => {
    const malformed = "this is not a valid lockfile";
    writeFileSync(lockPath(), malformed);

    expect(() => addSender(dataDir, "12345")).toThrow(LockfileContentionError);
    expect(readFileSync(lockPath(), "utf8")).toBe(malformed);
    expect(
      readdirSync(dataDir).filter((entry) => entry.startsWith(".allowed-senders.lock.tmp.")),
    ).toEqual([]);
  });

  it("T1 (CRITICAL): concurrent addSender preserves both writes (transformer pattern)", async () => {
    // In a single process this is serial via the sync save loop; the test guards
    // against any future refactor that re-introduces load-then-save-outside-lock.
    await Promise.all([
      Promise.resolve().then(() => addSender(dataDir, "11111")),
      Promise.resolve().then(() => addSender(dataDir, "22222")),
    ]);
    const result = loadAllowedSenders(dataDir);
    expect(result.allowFrom.sort()).toEqual(["11111", "22222"]);
  });

  it("T1: corrupt file → next addSender succeeds via defaultPairingState() base", () => {
    writeFileSync(join(dataDir, "allowed-senders.json"), "{not valid json");
    vi.spyOn(console, "error").mockImplementation(() => {});
    addSender(dataDir, "12345");
    const result = loadAllowedSenders(dataDir);
    expect(result.allowFrom).toEqual(["12345"]);
    expect(result.dmPolicy).toBe("allowlist");
  });
});

describe("listSenders / readKnownSessions", () => {
  function seedSession(chatId: string, lines: number): void {
    const sessionsDir = join(dataDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const file = join(sessionsDir, `telegram:${chatId}.jsonl`);
    const content = Array.from({ length: lines })
      .map((_, i) =>
        JSON.stringify({ role: i % 2 === 0 ? "user" : "assistant", content: "x", ts: Date.now() }),
      )
      .join("\n");
    writeFileSync(file, content);
  }

  it("readKnownSessions returns chatId/lineCount/mtime per session file", async () => {
    seedSession("12345", 4);
    seedSession("67890", 12);
    const sessions = await readKnownSessions(dataDir);
    const byId = new Map(sessions.map((s) => [s.chatId, s]));
    expect(byId.get("12345")?.lineCount).toBe(4);
    expect(byId.get("67890")?.lineCount).toBe(12);
    expect(byId.get("12345")?.mtime).toBeGreaterThan(0);
  });

  it("readKnownSessions returns empty array when sessions dir does not exist", async () => {
    expect(await readKnownSessions(dataDir)).toEqual([]);
  });

  it("listSenders returns current allowed-senders state plus session candidates", async () => {
    addSender(dataDir, "12345");
    seedSession("12345", 4);
    seedSession("99999", 2);
    const result = await listSenders(dataDir);
    expect(result.senders.dmPolicy).toBe("allowlist");
    expect(result.senders.allowFrom).toEqual(["12345"]);
    expect(result.sessionCandidates.length).toBe(2);
    const chatIds = result.sessionCandidates.map((c) => c.chatId).sort();
    expect(chatIds).toEqual(["12345", "99999"]);
  });
});

describe("loadAllowedSenders — mtime cache", () => {
  it("re-uses parsed state when mtime is unchanged (cache hit)", () => {
    addSender(dataDir, "12345");
    // First call populates / refreshes the cache.
    const first = loadAllowedSenders(dataDir);
    // Spy on JSON.parse to detect cache hits.
    const parseSpy = vi.spyOn(JSON, "parse");
    const second = loadAllowedSenders(dataDir);
    const third = loadAllowedSenders(dataDir);
    expect(parseSpy).not.toHaveBeenCalled();
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    parseSpy.mockRestore();
  });

  it("write via saveAllowedSenders → next load reflects the change", () => {
    addSender(dataDir, "12345");
    expect(loadAllowedSenders(dataDir).allowFrom).toEqual(["12345"]);
    addSender(dataDir, "67890");
    expect(loadAllowedSenders(dataDir).allowFrom).toEqual(["12345", "67890"]);
  });

  it("file deleted out-of-band → cache cleared, default returned", () => {
    addSender(dataDir, "12345");
    expect(loadAllowedSenders(dataDir).dmPolicy).toBe("allowlist");
    rmSync(join(dataDir, "allowed-senders.json"));
    const result = loadAllowedSenders(dataDir);
    expect(result.dmPolicy).toBe("pairing");
    expect(result.allowFrom).toEqual([]);
  });

  it("invalidates cached authorization when a peer replaces the file at the same mtime", () => {
    addSender(dataDir, "12345");
    const path = join(dataDir, "allowed-senders.json");
    const fixedMtimeSeconds = 915_148_800;
    utimesSync(path, fixedMtimeSeconds, fixedMtimeSeconds);
    expect(loadAllowedSenders(dataDir).allowFrom).toEqual(["12345"]);
    const before = statSync(path);
    const replacement = `${path}.peer`;
    const revokedJson = JSON.stringify(defaultPairingState());
    const paddingLength = Number(before.size) - Buffer.byteLength(revokedJson);
    expect(paddingLength).toBeGreaterThanOrEqual(0);
    writeFileSync(replacement, revokedJson + " ".repeat(paddingLength), { mode: 0o600 });
    utimesSync(replacement, fixedMtimeSeconds, fixedMtimeSeconds);
    const replacementInode = statSync(replacement).ino;
    renameSync(replacement, path);
    const after = statSync(path);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
    expect(after.ino).toBe(replacementInode);
    expect(after.ino).not.toBe(before.ino);

    expect(loadAllowedSenders(dataDir)).toEqual(defaultPairingState());
  });
});

describe("saveAllowedSenders — data-dir perms (S3)", () => {
  it("tightens pre-existing dataDir from 0o755 to 0o700 and logs", () => {
    chmodSync(dataDir, 0o755);
    expect(statSync(dataDir).mode & 0o777).toBe(0o755);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    addSender(dataDir, "12345");
    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/\[security\].*permissions.*0o700/));
    errSpy.mockRestore();
  });
});
