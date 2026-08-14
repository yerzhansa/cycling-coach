import { createHash, randomBytes as systemRandomBytes, timingSafeEqual } from "node:crypto";
import type {
  IntervalsCredentialVerificationEvidence,
  IntervalsStoreOwnerState,
} from "./account-identity.js";

export const INTERVALS_CREDENTIAL_APPROVAL_TTL_MS = 60_000;
export const INTERVALS_PENDING_APPROVALS_PER_GENERATION = 1;
export const INTERVALS_APPROVAL_TOKEN_BYTES = 32;

export interface IntervalsCredentialApprovalIssue {
  readonly apiKey: string;
  readonly configuredAthleteSelector: string;
  readonly athleteSelector: string;
  readonly evidence: IntervalsCredentialVerificationEvidence;
  readonly configRevision: number;
}

export interface IntervalsCredentialApprovalConsumption {
  readonly approval: string;
  readonly credentialDigest: string;
  readonly configuredAthleteSelector: string;
  readonly requestedAthleteSelector?: string;
  readonly ownerState: IntervalsStoreOwnerState;
  readonly configRevision: number;
}

export interface IntervalsCredentialApprovalResult {
  readonly athleteSelector: string;
  readonly evidence: IntervalsCredentialVerificationEvidence;
}

export interface IntervalsCredentialApprovalStore {
  issue(input: IntervalsCredentialApprovalIssue): string;
  consume(
    input: IntervalsCredentialApprovalConsumption,
  ): IntervalsCredentialApprovalResult | undefined;
}

export interface IntervalsCredentialApprovalStoreDependencies {
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Uint8Array;
}

type PendingApproval = Readonly<{
  token: string;
  credentialDigest: string;
  configuredAthleteSelector: string;
  athleteSelector: string;
  evidence: IntervalsCredentialVerificationEvidence;
  configRevision: number;
  expiresAtMs: number;
}>;

export function digestIntervalsCredential(apiKey: string): string {
  if (typeof apiKey !== "string") throw new TypeError("invalid intervals credential");
  return createHash("sha256").update(apiKey).digest("hex");
}

export function normalizeIntervalsAthleteSelector(athleteSelector: string): string {
  if (typeof athleteSelector !== "string") {
    throw new TypeError("invalid intervals athlete selector");
  }
  return athleteSelector.length === 0 ? "0" : athleteSelector;
}

function validFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function validOwnerState(value: unknown): value is IntervalsStoreOwnerState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.status === "unowned") return Object.keys(record).length === 1;
  return (
    record.status === "owned" &&
    Object.keys(record).length === 2 &&
    validFingerprint(record.fingerprint)
  );
}

function validRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function ownerStatesMatch(
  left: IntervalsStoreOwnerState,
  right: IntervalsStoreOwnerState,
): boolean {
  return (
    left.status === right.status &&
    (left.status === "unowned" ||
      (right.status === "owned" && left.fingerprint === right.fingerprint))
  );
}

function tokensMatch(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(left) || !/^[0-9a-f]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function copyEvidence(
  evidence: IntervalsCredentialVerificationEvidence,
): IntervalsCredentialVerificationEvidence {
  if (
    !validFingerprint(evidence.verifiedFingerprint) ||
    !validOwnerState(evidence.ownerState) ||
    (evidence.ownerState.status === "owned" &&
      evidence.ownerState.fingerprint !== evidence.verifiedFingerprint)
  ) {
    throw new TypeError("invalid intervals credential verification evidence");
  }
  const ownerState: IntervalsStoreOwnerState =
    evidence.ownerState.status === "unowned"
      ? Object.freeze({ status: "unowned" })
      : Object.freeze({ status: "owned", fingerprint: evidence.ownerState.fingerprint });
  return Object.freeze({
    verifiedFingerprint: evidence.verifiedFingerprint,
    ownerState,
  });
}

export function createIntervalsCredentialApprovalStore(
  dependencies: IntervalsCredentialApprovalStoreDependencies = {},
): IntervalsCredentialApprovalStore {
  const now = dependencies.now ?? Date.now;
  const randomBytes = dependencies.randomBytes ?? systemRandomBytes;
  let pending: PendingApproval | undefined;

  return Object.freeze({
    issue(input: IntervalsCredentialApprovalIssue) {
      if (typeof input.apiKey !== "string" || input.apiKey.length === 0) {
        throw new TypeError("invalid intervals credential");
      }
      if (!validRevision(input.configRevision)) {
        throw new TypeError("invalid intervals config revision");
      }
      const configuredAthleteSelector = normalizeIntervalsAthleteSelector(
        input.configuredAthleteSelector,
      );
      const athleteSelector = normalizeIntervalsAthleteSelector(input.athleteSelector);
      const evidence = copyEvidence(input.evidence);
      if (configuredAthleteSelector !== athleteSelector && evidence.ownerState.status !== "owned") {
        throw new TypeError("unowned intervals approval cannot change athlete selector");
      }
      const issuedAtMs = now();
      const expiresAtMs = issuedAtMs + INTERVALS_CREDENTIAL_APPROVAL_TTL_MS;
      if (!Number.isSafeInteger(issuedAtMs) || !Number.isSafeInteger(expiresAtMs)) {
        throw new TypeError("invalid intervals approval time");
      }
      const previousToken = pending?.token;
      let token: string | undefined;
      for (let attempt = 0; attempt < 8 && token === undefined; attempt += 1) {
        const bytes = randomBytes(INTERVALS_APPROVAL_TOKEN_BYTES);
        if (bytes.byteLength !== INTERVALS_APPROVAL_TOKEN_BYTES) {
          throw new TypeError("invalid intervals approval entropy");
        }
        const candidate = Buffer.from(bytes).toString("hex");
        if (candidate !== previousToken) token = candidate;
      }
      if (token === undefined) throw new TypeError("intervals approval entropy repeated");
      pending = Object.freeze({
        token,
        credentialDigest: digestIntervalsCredential(input.apiKey),
        configuredAthleteSelector,
        athleteSelector,
        evidence,
        configRevision: input.configRevision,
        expiresAtMs,
      });
      return token;
    },

    consume(input: IntervalsCredentialApprovalConsumption) {
      const selected = pending;
      pending = undefined;
      if (selected === undefined) return undefined;
      const consumedAtMs = now();
      const configuredAthleteSelector =
        typeof input.configuredAthleteSelector === "string"
          ? normalizeIntervalsAthleteSelector(input.configuredAthleteSelector)
          : undefined;
      const requestedAthleteSelector =
        input.requestedAthleteSelector === undefined
          ? undefined
          : typeof input.requestedAthleteSelector === "string"
            ? normalizeIntervalsAthleteSelector(input.requestedAthleteSelector)
            : null;
      if (
        !Number.isSafeInteger(consumedAtMs) ||
        consumedAtMs >= selected.expiresAtMs ||
        !tokensMatch(selected.token, input.approval) ||
        !/^[0-9a-f]{64}$/.test(input.credentialDigest) ||
        selected.credentialDigest !== input.credentialDigest ||
        selected.configuredAthleteSelector !== configuredAthleteSelector ||
        requestedAthleteSelector === null ||
        (requestedAthleteSelector !== undefined &&
          selected.athleteSelector !== requestedAthleteSelector) ||
        !validOwnerState(input.ownerState) ||
        !ownerStatesMatch(selected.evidence.ownerState, input.ownerState) ||
        !validRevision(input.configRevision) ||
        selected.configRevision !== input.configRevision
      ) {
        return undefined;
      }
      return Object.freeze({
        athleteSelector: selected.athleteSelector,
        evidence: selected.evidence,
      });
    },
  });
}
