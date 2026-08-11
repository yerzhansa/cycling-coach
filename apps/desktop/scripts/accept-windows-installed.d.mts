import type { WindowsParityScenarioCollection } from "./windows-parity-scenarios.mjs";

export type WindowsInstalledChecklistResult = "pass" | "fail" | "incomplete";

export type WindowsInstalledAcceptanceStage =
  | "architecture"
  | "automation"
  | "closure-shape"
  | "coverage-class"
  | "coverage-content"
  | "coverage-duplicate"
  | "coverage-missing"
  | "coverage-shape"
  | "coverage-unknown"
  | "execution"
  | "live-smoke-result"
  | "live-smoke-separation"
  | "mode"
  | "plan-input"
  | "platform"
  | "result"
  | "result-duplicate"
  | "result-integrity"
  | "result-plan"
  | "result-privacy"
  | "result-shape"
  | "scenario-citations"
  | "source-duplicate"
  | "totals"
  | "uninstall-duplicate"
  | "uninstall-missing"
  | "uninstall-protocol"
  | "uninstall-unknown"
  | "validation-input";

export class WindowsInstalledAcceptanceError extends Error {
  readonly stage: WindowsInstalledAcceptanceStage;
  constructor(stage: WindowsInstalledAcceptanceStage);
}

export interface WindowsInstalledAcceptanceTotals {
  readonly total: number;
  readonly deterministic: number;
  readonly vmOnly: number;
}

export interface WindowsInstalledEvidenceContract {
  readonly checklistResult: readonly ["pass", "fail", "incomplete"];
  readonly evidence: {
    readonly type: "free-text";
    readonly pathPolicy: "path-free";
    readonly credentialPolicy: "credential-free";
  };
}

export interface WindowsInstalledAutomatedEvidenceStep {
  readonly rowId: string;
  readonly surface: string;
  readonly expected: string;
  readonly tests: readonly string[];
}

export interface WindowsInstalledManualChecklistItem {
  readonly rowId: string;
  readonly surface: string;
  readonly reason: string;
  readonly evidenceContract: WindowsInstalledEvidenceContract;
}

export type WindowsInstalledUninstallPhase = "seed" | "uninstall" | "reinstall";

export interface WindowsInstalledUninstallReinstallSection {
  readonly phaseOrder: readonly ["seed", "uninstall", "reinstall"];
  readonly phases: readonly {
    readonly id: WindowsInstalledUninstallPhase;
    readonly requirement: string;
  }[];
  readonly rowMappings: readonly {
    readonly rowId: string;
    readonly phases: readonly ["seed", "uninstall", "reinstall"];
  }[];
  readonly durableInventory: readonly {
    readonly rowId: string;
    readonly durableClass: string;
  }[];
  readonly preservedDataRoots: readonly ["athlete-data root", "desktop user-data root"];
  readonly removedIntegrationState: readonly string[];
  readonly transientInventory: readonly [
    "updater cache and staging",
    "runtime locks",
    "daemon PID and port coordinates",
    "upgrade-fence claim coordinates",
    "crash temporaries",
  ];
  readonly transientAssertion: string;
}

export interface WindowsInstalledLiveSmoke {
  readonly id: string;
  readonly name: string;
  readonly check: string;
}

export interface WindowsInstalledAcceptancePlan {
  readonly schemaVersion: 1;
  readonly kind: "windows-installed-acceptance-plan";
  readonly manifests: readonly string[];
  readonly totals: WindowsInstalledAcceptanceTotals;
  readonly automatedEvidence: readonly WindowsInstalledAutomatedEvidenceStep[];
  readonly manualChecklist: readonly WindowsInstalledManualChecklistItem[];
  readonly uninstallReinstall: WindowsInstalledUninstallReinstallSection;
  readonly liveSmokeLane: {
    readonly mode: "live-smoke";
    readonly includedInDeterministicLane: false;
    readonly outputPolicy: {
      readonly secrets: "never";
      readonly identifiers: "redacted";
    };
    readonly smokes: readonly WindowsInstalledLiveSmoke[];
  };
}

export interface WindowsInstalledAcceptanceClosure {
  readonly valid: true;
  readonly totals: WindowsInstalledAcceptanceTotals;
}

export interface WindowsInstalledOutcomeInput {
  readonly checklistResult: WindowsInstalledChecklistResult;
  readonly evidence: string;
}

export interface WindowsInstalledRowOutcome extends WindowsInstalledOutcomeInput {
  readonly rowId: string;
  readonly lane: "automated" | "manual";
}

export interface WindowsInstalledAcceptanceResult {
  readonly schemaVersion: 1;
  readonly kind: "windows-installed-acceptance-result";
  readonly status: WindowsInstalledChecklistResult;
  readonly complete: boolean;
  readonly passed: boolean;
  readonly totals: {
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
    readonly incomplete: number;
  };
  readonly rows: readonly WindowsInstalledRowOutcome[];
}

export interface WindowsInstalledAcceptanceExecutionEntry {
  readonly lane: "automated" | "manual";
  readonly step: WindowsInstalledAutomatedEvidenceStep | WindowsInstalledManualChecklistItem;
}

export interface WindowsInstalledExecutionDependencies {
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
  readonly collectOutcome?: (
    entry: WindowsInstalledAcceptanceExecutionEntry,
  ) => WindowsInstalledOutcomeInput | Promise<WindowsInstalledOutcomeInput>;
}

export interface WindowsInstalledLiveSmokeExecutionDependencies {
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
  readonly collectOutcome?: (
    smoke: WindowsInstalledLiveSmoke,
  ) => WindowsInstalledOutcomeInput | Promise<WindowsInstalledOutcomeInput>;
}

export interface WindowsInstalledLiveSmokeResult {
  readonly schemaVersion: 1;
  readonly kind: "windows-installed-live-smoke-result";
  readonly status: WindowsInstalledChecklistResult;
  readonly complete: boolean;
  readonly passed: boolean;
  readonly totals: {
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
    readonly incomplete: number;
  };
  readonly rows: readonly {
    readonly smokeId: string;
    readonly checklistResult: WindowsInstalledChecklistResult;
    readonly evidence: string;
  }[];
}

export const WINDOWS_INSTALLED_ACCEPTANCE_MAX_UNBROKEN_TOKEN_RUN: 32;
export const WINDOWS_INSTALLED_ACCEPTANCE_LIVE_SMOKES: readonly WindowsInstalledLiveSmoke[];

export function createWindowsInstalledAcceptancePlan(
  collection: WindowsParityScenarioCollection,
): WindowsInstalledAcceptancePlan;
export function buildWindowsInstalledAcceptancePlan(): Promise<WindowsInstalledAcceptancePlan>;
export function validateWindowsInstalledAcceptanceClosure(
  collection: WindowsParityScenarioCollection,
  plan: WindowsInstalledAcceptancePlan,
): WindowsInstalledAcceptanceClosure;
export function requireWindowsInstalledExecutionPlatform(
  platform?: NodeJS.Platform,
  architecture?: string,
): void;
export function createWindowsInstalledAcceptanceResult(
  plan: WindowsInstalledAcceptancePlan,
  outcomes?: readonly (WindowsInstalledOutcomeInput & { readonly rowId: string })[],
): WindowsInstalledAcceptanceResult;
export function validateWindowsInstalledAcceptanceResult(
  plan: WindowsInstalledAcceptancePlan,
  artifact: unknown,
): WindowsInstalledAcceptanceResult;
export function executeWindowsInstalledAcceptance(
  input?: { readonly plan?: WindowsInstalledAcceptancePlan },
  dependencies?: WindowsInstalledExecutionDependencies,
): Promise<WindowsInstalledAcceptanceResult>;
export function executeWindowsInstalledLiveSmokes(
  dependencies?: WindowsInstalledLiveSmokeExecutionDependencies,
): Promise<WindowsInstalledLiveSmokeResult>;
