import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MACOS_UPDATER_ROUND_TRIP_FEED_URL,
  bindMacosUpdaterRoundTripFailureDiagnostic,
  createMacosUpdaterDownloadedStateProbe,
  createMacosUpdaterRoundTripEvidence,
  describeMacosUpdaterRoundTripFailure,
  observeMacosUpdaterState,
  parseMacosApplicationProcessObservation,
  parseMacosProcessTableObservation,
  parseMacosDownloadedUpdateInfo,
  requireMacosUpdaterRoundTripInput,
  retriggerMacosUpdaterCheck,
  sanitizeMacosUpdaterObservedState,
  shouldRetriggerMacosUpdaterCheck,
  verifyMacosUpdaterRoundTripIdentities,
  verifyMacosUpdaterRoundTripPersistence,
  waitForMacosUpdaterCondition,
  waitForMacosUpdaterDownloadedState,
  type MacosUpdaterRoundTripInput,
} from "../scripts/verify-updater-round-trip.mjs";
import type { VerifiedMacosReleaseApplication } from "../scripts/verify-macos-release.mjs";
import { runAcceptanceCommand } from "../scripts/support/packaged-telegram/acceptance-deadline.js";

const baselineVersion = "0.1.0";
const candidateVersion = "0.1.1";

const input: MacosUpdaterRoundTripInput = {
  baselineVersion,
  candidateVersion,
  baselineEnvelope: "/private/tmp/release-n",
  candidateEnvelope: "/private/tmp/release-n-plus-one",
  evidencePath: "/private/tmp/update-roundtrip.json",
};

function identity(
  version: string,
  codeDirectorySha256: string,
  overrides: Partial<VerifiedMacosReleaseApplication> = {},
): VerifiedMacosReleaseApplication {
  return {
    version,
    enduragentDesktopRelease: true,
    feedUrl: MACOS_UPDATER_ROUND_TRIP_FEED_URL,
    bundleIdentifier: "icu.enduragent.desktop",
    teamIdentifier: "FA494ACVTF",
    designatedRequirementSha256: "c".repeat(64),
    codeDirectorySha256,
    cdHash: codeDirectorySha256.slice(0, 40),
    ...overrides,
  };
}

function identities() {
  const baseline = identity(baselineVersion, "a".repeat(64));
  const candidate = identity(candidateVersion, "b".repeat(64));
  return {
    baselineVersion,
    candidateVersion,
    expectedFeedUrl: MACOS_UPDATER_ROUND_TRIP_FEED_URL,
    baseline,
    candidate,
    installedBaseline: { ...baseline },
    relaunched: { ...candidate },
  };
}

const persistence = {
  encryptedCredentialDecrypted: true,
  credentialCiphertextPreserved: true,
  settingsPreserved: true,
  sessionPreserved: true,
  memoryPreserved: true,
  athleteDataPreserved: true,
  appSupervisedWriterBeforeAndAfter: true,
  plaintextCredentialAbsent: true,
} as const;

function persistenceView(overrides: Record<string, unknown> = {}) {
  const digest = { size: 123, sha256: "a".repeat(64), sha512: "ciphertext-sha512" };
  return {
    owner: "app-supervised" as const,
    athleteHome: "/private/tmp/synthetic-athlete",
    credentialStatuses: [
      { slot: "openrouter", state: "configured", runtimeState: "stored-inactive" },
    ],
    credentialCiphertext: digest,
    latest: { ...digest, sha256: "d".repeat(64) },
    memory: { ...digest, sha256: "b".repeat(64) },
    session: { ...digest, sha256: "c".repeat(64) },
    runtimeConfig: { session: { timezone: "UTC", idleMinutes: 23 } },
    unitsPreference: { value: "imperial", source: "cycling" },
    athleteState: { schemaVersion: "1", lastUpdated: "2000-01-01T00:00:00.000Z" },
    ...overrides,
  };
}

describe("macOS updater round-trip input", () => {
  it("fails with phase-only diagnostics that do not expose CLI arguments", async () => {
    const sensitiveArgument = "updater-cli-secret-must-not-appear";
    const script = fileURLToPath(
      new URL("../scripts/verify-updater-round-trip.mjs", import.meta.url),
    );
    const result = await runAcceptanceCommand(
      process.execPath,
      [
        "--import",
        "tsx",
        script,
        "0.1.0",
        "0.1.1",
        sensitiveArgument,
        "/private/tmp/candidate-envelope",
        "/private/tmp/evidence.json",
      ],
      {
        allowFailure: true,
        timeoutMs: 5_000,
        environment: {
          ...process.env,
          ENDURAGENT_WINDOWED_ACK: "1",
        },
      },
    );

    expect(result.code).toBe(1);
    expect(result.signal).toBeNull();
    expect(result.stdout).toHaveLength(0);
    expect(result.stderr.toString("utf8")).toBe(
      "macOS updater round trip failed; phase=input-validation; cleanup=not-started; reason=round-trip requires a steady macOS arm64 runner\n",
    );
    expect(result.stderr.includes(sensitiveArgument)).toBe(false);
  });

  it("omits unknown error text and CLI paths from failure diagnostics", async () => {
    const sensitiveArgument = "updater-unknown-error-secret-must-not-appear";
    const script = fileURLToPath(
      new URL("../scripts/verify-updater-round-trip.mjs", import.meta.url),
    );
    const hostPreload = `data:text/javascript,${encodeURIComponent(
      'Object.defineProperty(process,"platform",{value:"darwin"});Object.defineProperty(process,"arch",{value:"arm64"});',
    )}`;
    const result = await runAcceptanceCommand(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        hostPreload,
        script,
        "0.1.0",
        "0.1.1",
        `/private/tmp/${sensitiveArgument}-baseline`,
        "/private/tmp/nonexistent-candidate-envelope",
        "/private/tmp/nonexistent-evidence.json",
      ],
      {
        allowFailure: true,
        timeoutMs: 5_000,
        environment: {
          ...process.env,
          ENDURAGENT_MACOS_UPDATE_ROUNDTRIP_MODE: "steady",
          ENDURAGENT_WINDOWED_ACK: "1",
        },
      },
    );

    expect(result.code).toBe(1);
    expect(result.signal).toBeNull();
    expect(result.stdout).toHaveLength(0);
    expect(result.stderr.toString("utf8")).toBe(
      "macOS updater round trip failed; phase=verify-release-envelopes; cleanup=not-started\n",
    );
    expect(result.stderr.includes(sensitiveArgument)).toBe(false);
  });

  it("accepts one strictly increasing stable pair on a steady arm64 macOS runner", () => {
    expect(
      requireMacosUpdaterRoundTripInput(input, {
        platform: "darwin",
        arch: "arm64",
        mode: "steady",
      }),
    ).toEqual(input);
  });

  it.each([
    { platform: "linux" as const, arch: "arm64", mode: "steady" },
    { platform: "darwin" as const, arch: "x64", mode: "steady" },
    { platform: "darwin" as const, arch: "arm64", mode: "developer" },
  ])("rejects an ineligible host context", (context) => {
    expect(() => requireMacosUpdaterRoundTripInput(input, context)).toThrow(
      "round-trip requires a steady macOS arm64 runner",
    );
  });

  it.each([
    { baselineVersion: candidateVersion },
    { baselineVersion: "0.2.0" },
    { candidateVersion: "v0.1.1" },
    { candidateVersion: "0.01.1" },
  ])("rejects a non-increasing or non-canonical version pair", (patch) => {
    expect(() =>
      requireMacosUpdaterRoundTripInput(
        { ...input, ...patch },
        { platform: "darwin", arch: "arm64", mode: "steady" },
      ),
    ).toThrow();
  });

  it.each([
    { baselineEnvelope: "relative" },
    { candidateEnvelope: input.baselineEnvelope },
    { evidencePath: "/private/tmp/evidence.txt" },
    { evidencePath: input.candidateEnvelope },
    { evidencePath: `${input.candidateEnvelope}/evidence.json` },
    { candidateEnvelope: `${input.baselineEnvelope}/candidate` },
  ])("rejects unsafe or aliased paths", (patch) => {
    expect(() =>
      requireMacosUpdaterRoundTripInput(
        { ...input, ...patch },
        { platform: "darwin", arch: "arm64", mode: "steady" },
      ),
    ).toThrow();
  });
});

describe("macOS updater identity continuity", () => {
  it("binds installed N and relaunched N+1 to the inspected release ZIP applications", () => {
    const result = verifyMacosUpdaterRoundTripIdentities(identities());

    expect(result).toEqual({
      bundleIdentifier: "icu.enduragent.desktop",
      teamIdentifier: "FA494ACVTF",
      designatedRequirementSha256: "c".repeat(64),
      baselineCodeDirectorySha256: "a".repeat(64),
      candidateCodeDirectorySha256: "b".repeat(64),
      candidateCdHash: "b".repeat(40),
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each([
    () => ({
      baseline: identity(baselineVersion, "a".repeat(64), { feedUrl: "https://example.com/" }),
    }),
    () => ({ candidate: identity(candidateVersion, "a".repeat(64)) }),
    () => ({ installedBaseline: identity(baselineVersion, "d".repeat(64)) }),
    () => ({ relaunched: identity(candidateVersion, "d".repeat(64)) }),
    () => ({ candidate: identity("0.1.2", "b".repeat(64)) }),
    () => ({
      candidate: {
        ...identity(candidateVersion, "b".repeat(64)),
        teamIdentifier: "OTHERTEAM",
      } as unknown as VerifiedMacosReleaseApplication,
    }),
    () => ({ expectedFeedUrl: "http://example.com/" }),
  ])("rejects identity, feed, version, or signer drift", (createPatch) => {
    expect(() =>
      verifyMacosUpdaterRoundTripIdentities({ ...identities(), ...createPatch() }),
    ).toThrow();
  });

  it("rejects a short CDHash that is not the full digest prefix", () => {
    expect(() =>
      verifyMacosUpdaterRoundTripIdentities({
        ...identities(),
        candidate: identity(candidateVersion, "b".repeat(64), { cdHash: "d".repeat(40) }),
      }),
    ).toThrow("candidate release identity is invalid");
  });
});

describe("downloaded updater cache binding", () => {
  const expected = {
    fileName: "Enduragent-2026.8.8-arm64-mac.zip",
    sha512: "candidate-sha512",
  };

  it("accepts only the electron-updater pending metadata bound to the candidate", () => {
    const parsed = parseMacosDownloadedUpdateInfo(
      { ...expected, isAdminRightsRequired: false },
      expected,
    );
    expect(parsed).toEqual({ ...expected, isAdminRightsRequired: false });
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it.each([
    { ...expected },
    { ...expected, isAdminRightsRequired: true },
    { ...expected, isAdminRightsRequired: false, extra: true },
    { ...expected, fileName: "other.zip", isAdminRightsRequired: false },
    { ...expected, sha512: "other", isAdminRightsRequired: false },
  ])("rejects cache metadata ambiguity", (value) => {
    expect(() => parseMacosDownloadedUpdateInfo(value, expected)).toThrow(
      "downloaded update metadata does not match the candidate",
    );
  });
});

describe("macOS updater state recovery diagnostics", () => {
  it("sanitizes observed state with deterministic bounds and redactions", () => {
    const sanitized = sanitizeMacosUpdaterObservedState({
      zulu: "z".repeat(80),
      path: "/private/tmp/update.zip",
      nested: { error: "private" },
      count: 12,
      active: true,
      absent: null,
      infinite: Number.POSITIVE_INFINITY,
      windowsPath: "C:\\Users\\athlete\\update.zip",
    });

    expect(sanitized).toBe(
      `{"absent":null,"active":true,"count":12,"infinite":"[non-primitive]","nested":"[non-primitive]","path":"[redacted]","windowsPath":"[redacted]","zulu":"${"z".repeat(64)}"}`,
    );
    expect(sanitized.length).toBeLessThanOrEqual(256);
  });

  it("bounds the whole state serialization and rejects non-objects", () => {
    const sanitized = sanitizeMacosUpdaterObservedState(
      Object.fromEntries(
        Array.from({ length: 20 }, (_value, index) => [`field-${index}`, "v".repeat(64)]),
      ),
    );

    expect(sanitized.length).toBe(256);
    expect(sanitizeMacosUpdaterObservedState(null)).toBe("unavailable");
    expect(sanitizeMacosUpdaterObservedState(["idle"])).toBe("unavailable");
    expect(sanitizeMacosUpdaterObservedState("idle")).toBe("unavailable");
  });

  it.each([
    [{ status: "failed", stage: "check" }, false, true],
    [{ status: "failed", stage: "download" }, false, true],
    [{ status: "current" }, true, true],
    [{ status: "idle" }, true, true],
    [{ status: "current" }, false, false],
    [{ status: "checking" }, true, false],
    [{ status: "downloading", version: candidateVersion }, true, false],
    [{ status: "downloaded", version: candidateVersion }, true, false],
    [{ status: "failed", stage: "install" }, true, false],
  ])(
    "decides whether a settled updater state should be re-triggered",
    (state, advertised, expected) => {
      expect(shouldRetriggerMacosUpdaterCheck(state, advertised)).toBe(expected);
    },
  );
});

describe("macOS updater downloaded-state recovery", () => {
  function createProbeForState(
    state: unknown,
    options: {
      readonly recheckFailures?: number;
      readonly retrigger?: () => Promise<void>;
      readonly now?: () => number;
    } = {},
  ) {
    return createMacosUpdaterDownloadedStateProbe({
      candidateVersion,
      observe: async () => ({
        state,
        recheckFailures: options.recheckFailures ?? 0,
      }),
      retrigger: options.retrigger ?? (async () => {}),
      now: options.now ?? (() => 0),
    });
  }

  it("resolves the exact candidate download without re-triggering", async () => {
    const state = { status: "downloaded", version: candidateVersion };
    let retriggerCalls = 0;
    const { probe, timeoutFailure } = createProbeForState(state, {
      retrigger: async () => {
        retriggerCalls += 1;
      },
    });

    await expect(
      waitForMacosUpdaterCondition("downloaded update state", probe, 20, 1, timeoutFailure),
    ).resolves.toEqual(state);
    expect(retriggerCalls).toBe(0);
  });

  it("gates re-trigger attempts with the 45-second backoff", async () => {
    let clock = 0;
    const retriggeredAt: number[] = [];
    const { probe } = createProbeForState(
      { status: "failed", stage: "check" },
      {
        now: () => clock,
        retrigger: async () => {
          retriggeredAt.push(clock);
        },
      },
    );

    await expect(probe()).resolves.toBe(false);
    clock = 44_999;
    await expect(probe()).resolves.toBe(false);
    clock = 45_000;
    await expect(probe()).resolves.toBe(false);

    expect(retriggeredAt).toHaveLength(2);
    expect(retriggeredAt).toEqual([0, 45_000]);
  });

  it("re-triggers an advertised current state but permits active transitions", async () => {
    let currentRetriggerCalls = 0;
    const current = createProbeForState(
      { status: "current" },
      {
        retrigger: async () => {
          currentRetriggerCalls += 1;
        },
      },
    );
    await expect(current.probe()).resolves.toBe(false);

    let transitionRetriggerCalls = 0;
    for (const state of [
      { status: "checking" },
      { status: "downloading", version: candidateVersion },
    ]) {
      const transition = createProbeForState(state, {
        retrigger: async () => {
          transitionRetriggerCalls += 1;
        },
      });
      await expect(transition.probe()).resolves.toBe(false);
    }

    expect(currentRetriggerCalls).toBe(1);
    expect(transitionRetriggerCalls).toBe(0);
  });

  it.each([
    { status: "disabled" },
    { status: "installing", version: candidateVersion },
    { status: "downloading", version: baselineVersion },
    { status: "downloaded", version: baselineVersion },
    { status: "restart-required", stage: "check" },
    { status: "checking", extra: true },
    { status: "idle", extra: true },
    { status: "downloading", version: candidateVersion, extra: true },
    "idle",
    null,
    ["idle"],
  ])("rejects a state outside the transition envelope immediately", async (state) => {
    const { probe, timeoutFailure } = createProbeForState(state);
    const startedAt = Date.now();

    await expect(
      waitForMacosUpdaterCondition("downloaded update state", probe, 60_000, 1, timeoutFailure),
    ).rejects.toThrow("observedState=");
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it("counts local and observed re-trigger failures in timeout diagnostics", async () => {
    let retriggerCalls = 0;
    const { probe, timeoutFailure } = createProbeForState(
      { status: "failed", stage: "check" },
      {
        recheckFailures: 2,
        retrigger: async () => {
          retriggerCalls += 1;
          throw new Error("private re-trigger failure");
        },
      },
    );

    await expect(probe()).resolves.toBe(false);
    const failure = timeoutFailure();

    expect(retriggerCalls).toBe(1);
    expect(failure.message).toContain("recheckAttempts=1; recheckFailures=3");
    expect(failure.message).not.toContain("private re-trigger failure");
  });

  async function timedOutFailure(lastError: unknown) {
    const observed = createProbeForState({ status: "checking" });
    await expect(observed.probe()).resolves.toBe(false);
    let failure: Error | undefined;
    try {
      await waitForMacosUpdaterCondition(
        "downloaded update state",
        async () => {
          throw lastError;
        },
        20,
        1,
        observed.timeoutFailure,
      );
    } catch (error) {
      if (error instanceof Error) failure = error;
    }
    return failure;
  }

  it("preserves a round-trip probe reason alongside the observed state", async () => {
    let probeError: unknown;
    try {
      parseMacosDownloadedUpdateInfo(null, {
        fileName: "Enduragent-0.1.1-arm64.zip",
        sha512: "candidate-sha512",
      });
    } catch (error) {
      probeError = error;
    }

    const failure = await timedOutFailure(probeError);

    expect(failure?.message).toContain('observedState={"status":"checking"}');
    expect(failure?.message).toContain(
      "lastError=downloaded update metadata does not match the candidate",
    );
  });

  it("omits unknown probe error text from timeout diagnostics", async () => {
    const failure = await timedOutFailure(new Error("private renderer detail"));

    expect(failure?.message).toContain('observedState={"status":"checking"}');
    expect(failure?.message).not.toContain("private renderer detail");
    expect(failure?.message).not.toContain("lastError=");
  });

  it("preserves state diagnostics when phase and cleanup are bound", async () => {
    const { probe, timeoutFailure } = createProbeForState(
      { status: "failed", stage: "check" },
      {
        recheckFailures: 2,
        retrigger: async () => {
          throw new Error("re-trigger failed");
        },
      },
    );
    await expect(probe()).resolves.toBe(false);
    const failure = timeoutFailure();

    expect(
      bindMacosUpdaterRoundTripFailureDiagnostic(failure, "download-update", "completed"),
    ).toBe(failure);
    expect(describeMacosUpdaterRoundTripFailure(failure)).toMatchObject({
      phase: "download-update",
      cleanup: "completed",
      reason: failure.message,
      observedState: '{"stage":"check","status":"failed"}',
      recheckAttempts: 1,
      recheckFailures: 3,
    });
  });

  it("reports default phase and cleanup for an unbound failure", () => {
    const { timeoutFailure } = createProbeForState({ status: "checking" });

    expect(describeMacosUpdaterRoundTripFailure(timeoutFailure())).toMatchObject({
      phase: "input-validation",
      cleanup: "not-started",
      observedState: "unavailable",
    });
  });
});

describe("macOS updater renderer bridge", () => {
  it("reads the updater state and re-check failure tally from the bridge", async () => {
    const expressions: string[] = [];

    await expect(
      observeMacosUpdaterState(async (expression) => {
        expressions.push(expression);
        return { state: { status: "checking" }, recheckFailures: 3 };
      }),
    ).resolves.toEqual({ state: { status: "checking" }, recheckFailures: 3 });
    expect(expressions).toHaveLength(1);
    expect(expressions[0]).toContain("window.enduragentAuth.getUpdateState()");
  });

  it("rejects a malformed updater state observation", async () => {
    await expect(
      observeMacosUpdaterState(async () => ({
        state: { status: "checking" },
        recheckFailures: -1,
      })),
    ).rejects.toThrow("updater state observation failed");
    await expect(observeMacosUpdaterState(async () => ({ status: "checking" }))).rejects.toThrow(
      "updater state observation failed",
    );
  });

  it("re-triggers the update check through the exposed bridge", async () => {
    const expressions: string[] = [];

    await retriggerMacosUpdaterCheck(async (expression) => {
      expressions.push(expression);
      return true;
    });

    expect(expressions).toHaveLength(1);
    expect(expressions[0]).toContain("window.enduragentAuth.checkForUpdates()");
  });

  it("fails when the bridge does not confirm the re-trigger", async () => {
    await expect(retriggerMacosUpdaterCheck(async () => false)).rejects.toThrow(
      "updater check re-trigger failed",
    );
  });

  it("recovers a failed check and resolves the candidate download over the bridge", async () => {
    const states: readonly unknown[] = [
      { status: "failed", stage: "check" },
      { status: "downloading", version: candidateVersion },
      { status: "downloaded", version: candidateVersion },
    ];
    const rechecks: string[] = [];
    let observations = 0;

    await expect(
      waitForMacosUpdaterDownloadedState(async (expression) => {
        if (expression.includes("window.enduragentAuth.checkForUpdates()")) {
          rechecks.push(expression);
          return true;
        }
        const state = states[Math.min(observations, states.length - 1)];
        observations += 1;
        return { state, recheckFailures: 0 };
      }, candidateVersion),
    ).resolves.toEqual({ status: "downloaded", version: candidateVersion });
    expect(rechecks).toHaveLength(1);
    expect(observations).toBe(3);
  });

  it("fails closed without burning the download deadline over the bridge", async () => {
    const startedAt = Date.now();

    await expect(
      waitForMacosUpdaterDownloadedState(
        async () => ({ state: { status: "disabled" }, recheckFailures: 0 }),
        candidateVersion,
      ),
    ).rejects.toThrow('observedState={"status":"disabled"}');
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});

describe("macOS updater persisted state continuity", () => {
  it("requires decryptable credentials and exact durable state under one app-supervised home", () => {
    const before = persistenceView();
    const after = persistenceView({
      runtimeConfig: { session: { idleMinutes: 23, timezone: "UTC" } },
    });
    const result = verifyMacosUpdaterRoundTripPersistence({
      before,
      after,
      plaintextCredentialAbsent: true,
    });

    expect(result).toEqual(persistence);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each([
    { after: persistenceView({ owner: "service-managed" }) },
    { after: persistenceView({ athleteHome: "/private/tmp/other-athlete" }) },
    { after: persistenceView({ credentialStatuses: [] }) },
    {
      after: persistenceView({
        credentialCiphertext: { size: 123, sha256: "d".repeat(64), sha512: "ciphertext-sha512" },
      }),
    },
    { after: persistenceView({ latest: { size: 1, sha256: "g", sha512: "g" } }) },
    { after: persistenceView({ memory: { size: 1, sha256: "e", sha512: "e" } }) },
    { after: persistenceView({ session: { size: 1, sha256: "f", sha512: "f" } }) },
    { after: persistenceView({ runtimeConfig: { session: { timezone: "Asia/Almaty" } } }) },
    { after: persistenceView({ unitsPreference: { value: "metric", source: "cycling" } }) },
    { after: persistenceView({ athleteState: { schemaVersion: "2" } }) },
  ])("rejects persisted state drift", ({ after }) => {
    expect(() =>
      verifyMacosUpdaterRoundTripPersistence({
        before: persistenceView(),
        after,
        plaintextCredentialAbsent: true,
      } as never),
    ).toThrow("persisted application state did not survive the update");
  });

  it("rejects credential plaintext found on disk", () => {
    expect(() =>
      verifyMacosUpdaterRoundTripPersistence({
        before: persistenceView(),
        after: persistenceView(),
        plaintextCredentialAbsent: false,
      } as never),
    ).toThrow("persisted application state did not survive the update");
  });
});

describe("macOS application process authority", () => {
  const application = "/private/tmp/installed/Enduragent.app";
  const executable = `${application}/Contents/MacOS/Enduragent`;
  const helper = `${application}/Contents/Frameworks/Enduragent Helper.app/Contents/MacOS/Enduragent Helper`;

  it("separates the main PID from all executable mappings inside the bundle", () => {
    const bytes = Buffer.from(
      [`p101`, "ftxt", `n${executable}`, `p102`, "ftxt", `n${helper}`, ""].join("\0"),
    );
    expect(parseMacosApplicationProcessObservation(bytes, application)).toEqual({
      bundlePids: [101, 102],
      mainPids: [101],
    });
  });

  it("keeps deleted old executable mappings inside bundle authority", () => {
    const bytes = Buffer.from(["p101", "ftxt", `n${executable} (deleted)`, ""].join("\0"));
    expect(parseMacosApplicationProcessObservation(bytes, application)).toEqual({
      bundlePids: [101],
      mainPids: [101],
    });
  });

  it.each([
    Buffer.from(["p101", "ftxt", "n/usr/bin/node", ""].join("\0")),
    Buffer.from(["p101", "ftxt", `n${executable}`, "p101", ""].join("\0")),
    Buffer.from(["ftxt", `n${executable}`, ""].join("\0")),
    Buffer.from(["p0", "ftxt", `n${executable}`, ""].join("\0")),
  ])("rejects malformed or out-of-authority process observations", (bytes) => {
    expect(() => parseMacosApplicationProcessObservation(bytes, application)).toThrow();
  });
});

describe("macOS launched process-tree authority", () => {
  it("records parentage and process birth identity without command-line data", () => {
    const bytes = Buffer.from(
      [" 101 1 Sun Aug  9 16:56:31 2026", " 102 101 Sun Aug  9 16:56:32 2026", ""].join("\n"),
    );

    expect(parseMacosProcessTableObservation(bytes)).toEqual([
      { pid: 101, parentPid: 1, startedAt: "Sun Aug 9 16:56:31 2026" },
      { pid: 102, parentPid: 101, startedAt: "Sun Aug 9 16:56:32 2026" },
    ]);
  });
});

describe("macOS updater evidence", () => {
  it("contains only redacted identities, exact-byte proof, and lifecycle claims", () => {
    const identityContinuity = verifyMacosUpdaterRoundTripIdentities(identities());
    const evidence = createMacosUpdaterRoundTripEvidence({
      baselineVersion,
      candidateVersion,
      initialPid: 101,
      relaunchedPid: 202,
      identity: identityContinuity,
      download: {
        fileName: "Enduragent-2026.8.8-arm64-mac.zip",
        size: 123,
        sha256: "d".repeat(64),
        sha512: "candidate-sha512",
      },
      persistence,
    });

    expect(evidence).toMatchObject({
      schemaVersion: 1,
      status: "passed",
      platform: "darwin-arm64",
      baselineVersion,
      candidateVersion,
      download: { exactBytes: true, updateInfoBound: true },
      application: { installedPathPreserved: true, initialPid: 101, relaunchedPid: 202 },
      lifecycle: {
        downloadedStateObserved: true,
        sidebarInstallActionInvoked: true,
        relaunchedApplicationObserved: true,
        finalShutdownEscalated: false,
        noOrphanBundleProcesses: true,
      },
      persistence,
    });
    expect(JSON.stringify(evidence)).not.toContain("/private/");
    expect(Object.isFrozen(evidence)).toBe(true);
  });

  it.each([
    { initialPid: 0 },
    { relaunchedPid: 0 },
    { relaunchedPid: 101 },
    { identity: undefined },
    { download: undefined },
    { persistence: undefined },
    { persistence: { ...persistence, memoryPreserved: false } },
    { baselineVersion: candidateVersion },
    { identity: { bundleIdentifier: "partial" } },
    {
      download: {
        fileName: "../candidate.zip",
        size: 123,
        sha256: "d".repeat(64),
        sha512: "candidate-sha512",
      },
    },
    {
      download: {
        fileName: "candidate.zip",
        size: 0,
        sha256: "d".repeat(64),
        sha512: "candidate-sha512",
      },
    },
  ])("rejects ambiguous evidence", (patch) => {
    const identityContinuity = verifyMacosUpdaterRoundTripIdentities(identities());
    expect(() =>
      createMacosUpdaterRoundTripEvidence({
        baselineVersion,
        candidateVersion,
        initialPid: 101,
        relaunchedPid: 202,
        identity: identityContinuity,
        download: {
          fileName: "candidate.zip",
          size: 123,
          sha256: "d".repeat(64),
          sha512: "candidate-sha512",
        },
        persistence,
        ...patch,
      } as never),
    ).toThrow("round-trip evidence is invalid");
  });
});
