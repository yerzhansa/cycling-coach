import type {
  MacosGenesisReleaseInput,
  MacosGenesisReleasePlan,
  MacosReleaseDependencies,
} from "./macos-release-plan.mjs";
import type { VerifiedMacosReleaseCandidateApplication } from "./verify-macos-release.mjs";

export interface MacosGenesisReleaseDependencies extends Omit<
  MacosReleaseDependencies,
  | "verifyBaselineApplication"
  | "verifyIdentityContinuity"
  | "verifyReleaseApplicationContents"
  | "sealReleaseMetadata"
  | "promoteReleaseEnvelope"
> {
  readonly sealReleaseMetadata?: (plan: MacosGenesisReleasePlan) => Promise<void>;
  readonly promoteReleaseEnvelope?: (
    plan: MacosGenesisReleasePlan,
    verifyEnvelope: (artifactDirectory: string) => Promise<unknown>,
  ) => Promise<string>;
  readonly verifyCandidateApplication?: (
    candidateApplication: string,
    options: { readonly candidateVersion: string },
  ) => Promise<VerifiedMacosReleaseCandidateApplication>;
  readonly verifyReleaseApplicationContents?: (
    artifactDirectory: string,
    options: {
      readonly candidateVersion: string;
      readonly looseCandidateCodeIdentity: {
        readonly codeDirectory: string;
        readonly cdHash: string;
      };
    },
    dependencies: { readonly executeFile?: MacosReleaseDependencies["executeFile"] },
  ) => Promise<void>;
}

export function runMacosGenesisRelease(
  input: MacosGenesisReleaseInput,
  dependencies?: MacosGenesisReleaseDependencies,
): Promise<{
  readonly plan: MacosGenesisReleasePlan;
  readonly artifacts: readonly string[];
  readonly envelopePath: string;
}>;
