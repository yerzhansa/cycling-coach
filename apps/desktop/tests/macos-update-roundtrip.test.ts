import { describe, expect, it } from "vitest";
import {
  MACOS_UPDATER_ROUND_TRIP_FEED_URL,
  createMacosUpdaterRoundTripEvidence,
  parseMacosApplicationProcessObservation,
  parseMacosDownloadedUpdateInfo,
  requireMacosUpdaterRoundTripInput,
  verifyMacosUpdaterRoundTripIdentities,
  verifyMacosUpdaterRoundTripPersistence,
  type MacosUpdaterRoundTripInput,
} from "../scripts/verify-updater-round-trip.mjs";
import type { VerifiedMacosReleaseApplication } from "../scripts/verify-macos-release.mjs";

const baselineVersion = "2026.8.7";
const candidateVersion = "2026.8.8";

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
    memory: { ...digest, sha256: "b".repeat(64) },
    session: { ...digest, sha256: "c".repeat(64) },
    runtimeConfig: { session: { timezone: "UTC", idleMinutes: 23 } },
    unitsPreference: { value: "imperial", source: "cycling" },
    athleteState: { schemaVersion: "1", lastUpdated: "2000-01-01T00:00:00.000Z" },
    ...overrides,
  };
}

describe("macOS updater round-trip input", () => {
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
    { baselineVersion: "2026.9.1" },
    { candidateVersion: "v2026.8.8" },
    { candidateVersion: "2026.08.8" },
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
    () => ({ candidate: identity("2026.8.9", "b".repeat(64)) }),
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
