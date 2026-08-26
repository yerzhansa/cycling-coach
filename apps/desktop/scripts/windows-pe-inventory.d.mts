export type WindowsPeKind = "application" | "runtime-library" | "uninstaller" | "installer";
export type WindowsPeLocation = "installer-payload" | "artifact";

export interface WindowsPeRequiredEntry {
  readonly path: string;
  readonly kind: WindowsPeKind;
  readonly location?: WindowsPeLocation;
}

export interface WindowsPeThirdPartyException {
  readonly path: string;
  readonly sha256: string;
  readonly upstreamSigner: string;
  readonly rationale: string;
}

export interface WindowsPeInventory {
  readonly schema: "windows-pe-inventory/1";
  readonly signing: {
    readonly tool: "electron-builder";
    readonly version: "26.15.3";
    readonly option: "win.signExts";
  };
  readonly required: readonly WindowsPeRequiredEntry[];
  readonly thirdPartyExceptions: readonly WindowsPeThirdPartyException[];
}

export interface WindowsPeInventoryDiff {
  readonly ok: boolean;
  readonly missing: readonly string[];
  readonly undeclared: readonly string[];
  readonly symlinks: readonly string[];
  readonly expected: readonly string[];
  readonly actual: readonly string[];
  readonly notInspected: readonly string[];
}

export function readWindowsPeInventory(path?: string): WindowsPeInventory;
export function isPortableExecutable(bytes: Uint8Array): boolean;
export function enumeratePortableExecutables(unpackedRoot: string): Promise<readonly string[]>;
export function diffWindowsPeInventory(input: {
  readonly unpackedRoot: string;
  readonly inventory: WindowsPeInventory;
  readonly version: string;
}): Promise<WindowsPeInventoryDiff>;
