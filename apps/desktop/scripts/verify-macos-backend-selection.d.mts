export declare const BACKEND_SELECTION_SERVICE: "icu.enduragent.desktop";
export declare const BACKEND_SELECTION_TEAM_IDENTIFIER: "FA494ACVTF";
export declare const BACKEND_SELECTION_PROBE_TIMEOUT_MS: number;
export declare const BACKEND_SELECTION_MAX_RESPONSE_BYTES: number;

export interface VerifiedMacosBackendSelection {
  readonly helper: string;
  readonly service: string;
  readonly teamIdentifier: string;
  readonly designatedRequirement: string;
}

export interface VerifyMacosBackendSelectionOverrides {
  readonly executeFile?: (executable: string, arguments_: readonly string[]) => Promise<unknown>;
  readonly requireHelper?: (helperPath: string) => Promise<void>;
  readonly verifyKeychainHelper?: (application: string) => Promise<unknown>;
  readonly runHelper?: (helperPath: string, request: string) => Promise<string | undefined>;
}

export declare function safeMacosBackendSelectionMessage(error: unknown): string | undefined;

export declare function backendSelectionProbeRequest(): string;

export declare function verifyMacosBackendSelection(
  application: string,
  overrides?: VerifyMacosBackendSelectionOverrides,
): Promise<VerifiedMacosBackendSelection>;
