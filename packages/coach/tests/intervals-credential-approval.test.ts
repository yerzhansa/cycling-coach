import { describe, expect, it } from "vitest";
import {
  createIntervalsCredentialApprovalStore,
  digestIntervalsCredential,
  INTERVALS_APPROVAL_TOKEN_BYTES,
  INTERVALS_CREDENTIAL_APPROVAL_TTL_MS,
  INTERVALS_PENDING_APPROVALS_PER_GENERATION,
} from "../src/intervals-credential-approval.js";
import type {
  IntervalsCredentialVerificationEvidence,
  IntervalsStoreOwnerState,
} from "../src/account-identity.js";

const fingerprint = "a".repeat(64);
const evidence: IntervalsCredentialVerificationEvidence = Object.freeze({
  verifiedFingerprint: fingerprint,
  ownerState: Object.freeze({ status: "unowned" }),
});
const ownedEvidence: IntervalsCredentialVerificationEvidence = Object.freeze({
  verifiedFingerprint: fingerprint,
  ownerState: Object.freeze({ status: "owned", fingerprint }),
});
const consumed = Object.freeze({ athleteSelector: "0", evidence });

function fixture() {
  let now = 1_000;
  let entropy = 0;
  const store = createIntervalsCredentialApprovalStore({
    now: () => now,
    randomBytes: (size) => Buffer.alloc(size, ++entropy),
  });
  const issue = () =>
    store.issue({
      apiKey: "candidate-key",
      configuredAthleteSelector: "",
      athleteSelector: "",
      evidence,
      configRevision: 7,
    });
  const consume = (
    approval: string,
    overrides: Partial<{
      credentialDigest: string;
      configuredAthleteSelector: string;
      requestedAthleteSelector: string;
      ownerState: IntervalsStoreOwnerState;
      configRevision: number;
    }> = {},
  ) =>
    store.consume({
      approval,
      credentialDigest: digestIntervalsCredential("candidate-key"),
      configuredAthleteSelector: "0",
      ownerState: { status: "unowned" },
      configRevision: 7,
      ...overrides,
    });
  return {
    store,
    issue,
    consume,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("intervals credential approval", () => {
  it("issues a 32-byte lowercase hex token and consumes it once", () => {
    const value = fixture();
    const approval = value.issue();

    expect(INTERVALS_APPROVAL_TOKEN_BYTES).toBe(32);
    expect(approval).toMatch(/^[0-9a-f]{64}$/);
    expect(value.consume(approval)).toEqual(consumed);
    expect(value.consume(approval)).toBeUndefined();
  });

  it("expires at the configured TTL and drops the expired entry", () => {
    const value = fixture();
    const approval = value.issue();

    expect(INTERVALS_CREDENTIAL_APPROVAL_TTL_MS).toBe(60_000);
    value.advance(INTERVALS_CREDENTIAL_APPROVAL_TTL_MS);
    expect(value.consume(approval)).toBeUndefined();
    value.advance(-1);
    expect(value.consume(approval)).toBeUndefined();
  });

  it("replaces a pending approval when another is issued", () => {
    const value = fixture();
    const replaced = value.issue();
    const current = value.issue();

    expect(current).not.toBe(replaced);
    expect(value.consume(current)).toEqual(consumed);
    expect(value.consume(replaced)).toBeUndefined();
  });

  it.each([
    {
      binding: "candidate digest",
      overrides: { credentialDigest: "b".repeat(64) },
    },
    {
      binding: "configured athlete selector",
      overrides: { configuredAthleteSelector: "different-athlete" },
    },
    {
      binding: "explicit requested athlete selector",
      overrides: { requestedAthleteSelector: "different-athlete" },
    },
    {
      binding: "owner state",
      overrides: {
        ownerState: { status: "owned", fingerprint } as const,
      },
    },
    {
      binding: "config revision",
      overrides: { configRevision: 8 },
    },
  ])("drops the entry on a wrong $binding", ({ overrides }) => {
    const value = fixture();
    const approval = value.issue();

    expect(value.consume(approval, overrides)).toBeUndefined();
    expect(value.consume(approval)).toBeUndefined();
  });

  it("drops the pending entry when a different token is presented", () => {
    const value = fixture();
    const approval = value.issue();

    expect(value.consume("f".repeat(64))).toBeUndefined();
    expect(value.consume(approval)).toBeUndefined();
  });

  it("keeps one pending entry across repeated issues", () => {
    const value = fixture();
    const approvals = Array.from({ length: 10 }, () => value.issue());

    expect(INTERVALS_PENDING_APPROVALS_PER_GENERATION).toBe(1);
    expect(value.consume(approvals.at(-1)!)).toEqual(consumed);
    for (const approval of approvals.slice(0, -1)) {
      expect(value.consume(approval)).toBeUndefined();
    }
  });

  it("returns the verified selector only when an explicit requested selector matches it", () => {
    const store = createIntervalsCredentialApprovalStore({
      now: () => 1_000,
      randomBytes: (size) => Buffer.alloc(size, 1),
    });
    const issue = () =>
      store.issue({
        apiKey: "candidate-key",
        configuredAthleteSelector: "stale-athlete",
        athleteSelector: "0",
        evidence: ownedEvidence,
        configRevision: 7,
      });
    const consume = (approval: string, requestedAthleteSelector?: string) =>
      store.consume({
        approval,
        credentialDigest: digestIntervalsCredential("candidate-key"),
        configuredAthleteSelector: "stale-athlete",
        ...(requestedAthleteSelector === undefined ? {} : { requestedAthleteSelector }),
        ownerState: { status: "owned", fingerprint },
        configRevision: 7,
      });

    expect(consume(issue())).toEqual({ athleteSelector: "0", evidence: ownedEvidence });
    expect(consume(issue(), "0")).toEqual({ athleteSelector: "0", evidence: ownedEvidence });
    const mismatched = issue();
    expect(consume(mismatched, "stale-athlete")).toBeUndefined();
    expect(consume(mismatched, "0")).toBeUndefined();
  });

  it("rejects a selector-changing approval for an unowned store", () => {
    const store = createIntervalsCredentialApprovalStore({
      now: () => 1_000,
      randomBytes: (size) => Buffer.alloc(size, 1),
    });

    expect(() =>
      store.issue({
        apiKey: "candidate-key",
        configuredAthleteSelector: "stale-athlete",
        athleteSelector: "0",
        evidence,
        configRevision: 7,
      }),
    ).toThrow(new TypeError("unowned intervals approval cannot change athlete selector"));
  });
});
