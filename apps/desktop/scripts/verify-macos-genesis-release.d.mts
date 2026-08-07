import type { verifyMacosGenesisReleaseEnvelope } from "./verify-macos-release.mjs";

interface WritableText {
  write(value: string): unknown;
}

export interface MacosGenesisVerifierDependencies {
  readonly verifyEnvelope?: typeof verifyMacosGenesisReleaseEnvelope;
  readonly stdout?: WritableText;
  readonly stderr?: WritableText;
}

export interface MacosGenesisVerifierInput {
  readonly artifactDirectory: string;
  readonly candidateApplication: string;
}

export function verifyMacosGenesisRelease(
  input: MacosGenesisVerifierInput,
  dependencies?: MacosGenesisVerifierDependencies,
): ReturnType<typeof verifyMacosGenesisReleaseEnvelope>;

export function runMacosGenesisVerifierCli(
  arguments_: readonly string[],
  dependencies?: MacosGenesisVerifierDependencies,
): Promise<0 | 1>;
