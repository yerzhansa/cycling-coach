export type WindowsParityScenario =
  | {
      readonly id: string;
      readonly surface: string;
      readonly expected: string;
      readonly automation: "deterministic";
      readonly test: string;
    }
  | {
      readonly id: string;
      readonly surface: string;
      readonly expected: string;
      readonly automation: "deterministic";
      readonly tests: readonly string[];
    }
  | {
      readonly id: string;
      readonly surface: string;
      readonly expected: string;
      readonly automation: "vm-only";
    };

export type WindowsParityScenarioManifestStage =
  | "configuration"
  | "read"
  | "size"
  | "parse"
  | "schema"
  | "duplicate-id";

export class WindowsParityScenarioManifestError extends Error {
  readonly stage: WindowsParityScenarioManifestStage;
  constructor(stage: WindowsParityScenarioManifestStage);
}

export interface WindowsParityScenarioLoaderInput {
  readonly directory?: string;
  readonly manifestNames?: readonly string[];
}

export interface WindowsParityScenarioLoaderDependencies {
  readonly readFile?: (path: string, encoding: "utf8") => Promise<string>;
}

export interface WindowsParityScenarioCollection {
  readonly schemaVersion: 1;
  readonly manifests: readonly string[];
  readonly scenarios: readonly WindowsParityScenario[];
}

export const WINDOWS_PARITY_SCENARIO_MANIFEST_MAX_BYTES: 1048576;
export const DEFAULT_WINDOWS_PARITY_SCENARIO_MANIFESTS: readonly [
  "chat-settings.scenarios.json",
  "training.scenarios.json",
  "telegram.scenarios.json",
  "shell-lifecycle.scenarios.json",
];

export function loadWindowsParityScenarios(
  input?: WindowsParityScenarioLoaderInput,
  dependencies?: WindowsParityScenarioLoaderDependencies,
): Promise<WindowsParityScenarioCollection>;
