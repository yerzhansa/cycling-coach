import type { Stats } from "node:fs";
import type { ReleaseArtifactNames } from "./macos-release-plan.mjs";

export interface VerifiedMacosReleaseArtifacts {
  readonly version: string;
  readonly names: ReleaseArtifactNames;
  readonly paths: {
    readonly dmg: string;
    readonly zip: string;
    readonly blockmap: string;
    readonly metadata: string;
  };
  readonly sizes: {
    readonly dmg: number;
    readonly zip: number;
    readonly blockmap: number;
  };
  readonly dmgSha512: string;
  readonly zipSha512: string;
}

export interface VerifyMacosReleaseOptions {
  readonly repositoryRoot?: string;
  readonly readVersionFile?: (path: string, encoding: "utf8") => Promise<string>;
}

export interface VerifyMacosReleaseDependencies {
  readonly executeFile?: (executable: string, arguments_: readonly string[]) => Promise<unknown>;
  readonly lstat?: (path: string) => Promise<Stats>;
  readonly mkdtemp?: (prefix: string) => Promise<string>;
  readonly readFile?: (path: string) => Promise<Buffer>;
  readonly readdir?: (path: string) => Promise<string[]>;
  readonly rm?: (
    path: string,
    options: { readonly recursive: true; readonly force: true },
  ) => Promise<void>;
  readonly tmpdir?: () => string;
  readonly buildBlockMap?: (
    inputPath: string,
    compression: "gzip",
    outputPath: string,
  ) => Promise<unknown>;
  readonly verifySignature?: (artifacts: VerifiedMacosReleaseArtifacts) => Promise<void>;
  readonly verifyNotarization?: (artifacts: VerifiedMacosReleaseArtifacts) => Promise<void>;
}

export function verifyMacosApplication(
  application: string,
  dependencies?: Pick<VerifyMacosReleaseDependencies, "executeFile">,
): Promise<void>;
export function verifyMacosDmg(
  dmgPath: string,
  dependencies?: Pick<VerifyMacosReleaseDependencies, "executeFile">,
): Promise<void>;
export function verifyMacosReleaseArtifacts(
  artifactDirectory: string,
  options?: VerifyMacosReleaseOptions,
  dependencies?: VerifyMacosReleaseDependencies,
): Promise<VerifiedMacosReleaseArtifacts>;
