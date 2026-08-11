import type {
  VerifiedMacosReleaseApplication,
  VerifiedMacosReleaseArtifacts,
} from "./verify-macos-release.mjs";

export const MACOS_UPDATER_ROUND_TRIP_MODE: "steady";
export const MACOS_UPDATER_ROUND_TRIP_FEED_URL: string;

export interface MacosUpdaterRoundTripInput {
  readonly baselineVersion: string;
  readonly candidateVersion: string;
  readonly baselineEnvelope: string;
  readonly candidateEnvelope: string;
  readonly evidencePath: string;
}

export interface VerifiedMacosUpdaterRoundTripInput extends MacosUpdaterRoundTripInput {}

export interface MacosUpdaterRoundTripContext {
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly mode?: string;
}

export interface MacosUpdaterDownloadedStateProbeContext {
  readonly candidateVersion: string;
  readonly observe: () => Promise<{
    readonly state: unknown;
    readonly recheckFailures: number;
  }>;
  readonly retrigger: () => Promise<void>;
  readonly now?: () => number;
}

export interface MacosUpdaterDownloadedStateProbe {
  readonly probe: () => Promise<unknown>;
  readonly timeoutFailure: (lastError?: unknown) => Error;
}

export type MacosUpdaterRoundTripFailureDiagnostic = Readonly<{
  phase: string;
  cleanup: string;
  reason?: string;
  observedState?: string;
  recheckAttempts?: number;
  recheckFailures?: number;
  lastErrorReason?: string;
}>;

export interface MacosApplicationProcessObservation {
  readonly bundlePids: readonly number[];
  readonly mainPids: readonly number[];
}

export interface MacosProcessIdentity {
  readonly pid: number;
  readonly parentPid: number;
  readonly startedAt: string;
}

export interface MacosTrackedApplicationProcessObservation extends MacosApplicationProcessObservation {
  readonly ownedPids: readonly number[];
  readonly ownedProcesses: readonly MacosProcessIdentity[];
}

export interface MacosApplicationProcessObserverContext {
  readonly observeBundleProcesses?: () => Promise<MacosApplicationProcessObservation>;
  readonly readProcessTable?: () => Promise<readonly MacosProcessIdentity[]>;
  readonly signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
  readonly trackingIntervalMs?: number;
}

export interface MacosApplicationProcessObserver {
  readonly close: () => Promise<void>;
  readonly freezeAll: () => Promise<void>;
  readonly freezeRoot: (identity: MacosProcessIdentity) => Promise<readonly MacosProcessIdentity[]>;
  readonly observe: () => Promise<MacosTrackedApplicationProcessObservation>;
  readonly signalAll: (signal: NodeJS.Signals) => Promise<boolean>;
  readonly signalIdentity: (
    identity: MacosProcessIdentity,
    signal: NodeJS.Signals,
  ) => Promise<boolean>;
  readonly trackRoot: (pid: number) => Promise<MacosProcessIdentity>;
}

export interface MacosDownloadedUpdateInfo {
  readonly fileName: string;
  readonly sha512: string;
  readonly isAdminRightsRequired: false;
}

export interface MacosUpdaterRoundTripIdentityContinuity {
  readonly bundleIdentifier: string;
  readonly teamIdentifier: string;
  readonly designatedRequirementSha256: string;
  readonly baselineCodeDirectorySha256: string;
  readonly candidateCodeDirectorySha256: string;
  readonly candidateCdHash: string;
}

export interface MacosUpdaterRoundTripPersistence {
  readonly encryptedCredentialDecrypted: true;
  readonly credentialCiphertextPreserved: true;
  readonly settingsPreserved: true;
  readonly sessionPreserved: true;
  readonly memoryPreserved: true;
  readonly athleteDataPreserved: true;
  readonly appSupervisedWriterBeforeAndAfter: true;
  readonly plaintextCredentialAbsent: true;
}

export interface MacosUpdaterRoundTripPersistenceView {
  readonly owner: "app-supervised";
  readonly athleteHome: string;
  readonly credentialStatuses: readonly unknown[];
  readonly credentialCiphertext: {
    readonly size: number;
    readonly sha256: string;
    readonly sha512: string;
  };
  readonly latest: { readonly size: number; readonly sha256: string; readonly sha512: string };
  readonly memory: { readonly size: number; readonly sha256: string; readonly sha512: string };
  readonly session: { readonly size: number; readonly sha256: string; readonly sha512: string };
  readonly runtimeConfig: unknown;
  readonly unitsPreference: unknown;
  readonly athleteState: unknown;
}

export interface MacosUpdaterRoundTripEvidence {
  readonly schemaVersion: 1;
  readonly status: "passed";
  readonly platform: "darwin-arm64";
  readonly baselineVersion: string;
  readonly candidateVersion: string;
  readonly feedUrl: string;
  readonly download: {
    readonly fileName: string;
    readonly size: number;
    readonly sha256: string;
    readonly sha512: string;
    readonly exactBytes: true;
    readonly updateInfoBound: true;
  };
  readonly application: MacosUpdaterRoundTripIdentityContinuity & {
    readonly installedPathPreserved: true;
    readonly initialPid: number;
    readonly relaunchedPid: number;
  };
  readonly lifecycle: {
    readonly downloadedStateObserved: true;
    readonly sidebarInstallActionInvoked: true;
    readonly initialApplicationExitedCleanly: true;
    readonly relaunchedApplicationObserved: true;
    readonly oldApplicationProcessesGone: true;
    readonly finalShutdownSignal: "SIGTERM";
    readonly finalShutdownEscalated: false;
    readonly noOrphanBundleProcesses: true;
  };
  readonly persistence: MacosUpdaterRoundTripPersistence;
}

export interface MacosUpdaterRoundTripOverrides extends MacosUpdaterRoundTripContext {
  readonly verifyArtifacts?: (
    envelope: string,
    version: string,
  ) => Promise<VerifiedMacosReleaseArtifacts>;
  readonly inspectApplication?: (application: string) => Promise<VerifiedMacosReleaseApplication>;
  readonly createScratch?: () => Promise<{
    readonly path: string;
    readonly identity: { readonly dev: number; readonly ino: number; readonly mode: number };
  }>;
  readonly removeScratch?: (scratch: {
    readonly path: string;
    readonly identity: { readonly dev: number; readonly ino: number; readonly mode: number };
  }) => Promise<void>;
  readonly observeProcesses?: (application: string) => Promise<MacosApplicationProcessObservation>;
  readonly readProcessTable?: () => Promise<readonly MacosProcessIdentity[]>;
  readonly writeEvidence?: (path: string, evidence: MacosUpdaterRoundTripEvidence) => Promise<void>;
}

export function requireMacosUpdaterRoundTripInput(
  input: MacosUpdaterRoundTripInput,
  context?: MacosUpdaterRoundTripContext,
): VerifiedMacosUpdaterRoundTripInput;

export function verifyMacosUpdaterRoundTripIdentities(input: {
  readonly baselineVersion: string;
  readonly candidateVersion: string;
  readonly expectedFeedUrl: string;
  readonly baseline: VerifiedMacosReleaseApplication;
  readonly candidate: VerifiedMacosReleaseApplication;
  readonly installedBaseline: VerifiedMacosReleaseApplication;
  readonly relaunched: VerifiedMacosReleaseApplication;
}): MacosUpdaterRoundTripIdentityContinuity;

export function parseMacosDownloadedUpdateInfo(
  value: unknown,
  expected: { readonly fileName: string; readonly sha512: string },
): MacosDownloadedUpdateInfo;

export function sanitizeMacosUpdaterObservedState(value: unknown): string;

export function shouldRetriggerMacosUpdaterCheck(
  state: unknown,
  candidateAdvertised: boolean,
): boolean;

export function createMacosUpdaterDownloadedStateProbe(
  context: MacosUpdaterDownloadedStateProbeContext,
): Readonly<MacosUpdaterDownloadedStateProbe>;

export function observeMacosUpdaterState(
  evaluate: (expression: string) => Promise<unknown>,
): Promise<{ readonly state: unknown; readonly recheckFailures: number }>;

export function retriggerMacosUpdaterCheck(
  evaluate: (expression: string) => Promise<unknown>,
): Promise<void>;

export function waitForMacosUpdaterDownloadedState(
  evaluate: (expression: string) => Promise<unknown>,
  candidateVersion: string,
): Promise<unknown>;

export function waitForMacosUpdaterCondition<T>(
  description: string,
  probe: () => Promise<T | false | undefined>,
  timeoutMs: number,
  intervalMs?: number,
  timeoutFailure?: (lastError?: unknown) => Error,
): Promise<T>;

export function describeMacosUpdaterRoundTripFailure(
  error: unknown,
): MacosUpdaterRoundTripFailureDiagnostic;

export function bindMacosUpdaterRoundTripFailureDiagnostic(
  error: unknown,
  phase: string,
  cleanup: string,
): Error;

export function parseMacosApplicationProcessObservation(
  bytes: Uint8Array,
  application: string,
): MacosApplicationProcessObservation;

export function parseMacosProcessTableObservation(
  bytes: Uint8Array,
): readonly MacosProcessIdentity[];

export function createMacosApplicationProcessObserver(
  application: string,
  context?: MacosApplicationProcessObserverContext,
): MacosApplicationProcessObserver;

export function verifyMacosUpdaterRoundTripPersistence(input: {
  readonly before: MacosUpdaterRoundTripPersistenceView;
  readonly after: MacosUpdaterRoundTripPersistenceView;
  readonly plaintextCredentialAbsent: true;
}): MacosUpdaterRoundTripPersistence;

export function createMacosUpdaterRoundTripEvidence(input: {
  readonly baselineVersion: string;
  readonly candidateVersion: string;
  readonly initialPid: number;
  readonly relaunchedPid: number;
  readonly identity: MacosUpdaterRoundTripIdentityContinuity;
  readonly download: {
    readonly fileName: string;
    readonly size: number;
    readonly sha256: string;
    readonly sha512: string;
  };
  readonly persistence: MacosUpdaterRoundTripPersistence;
}): MacosUpdaterRoundTripEvidence;

export function runMacosUpdaterRoundTrip(
  input: MacosUpdaterRoundTripInput,
  overrides?: MacosUpdaterRoundTripOverrides,
): Promise<MacosUpdaterRoundTripEvidence>;
