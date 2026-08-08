import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyMacosGenesisReleaseEnvelope } from "./verify-macos-release.mjs";

export async function verifyMacosGenesisRelease(input, dependencies = {}) {
  if (
    typeof input?.artifactDirectory !== "string" ||
    !isAbsolute(input.artifactDirectory) ||
    typeof input?.candidateApplication !== "string" ||
    !isAbsolute(input.candidateApplication)
  ) {
    throw new TypeError("macOS genesis verifier paths are invalid");
  }
  const verifyEnvelope =
    dependencies.verifyEnvelope ??
    ((artifactDirectory, candidateApplication) =>
      verifyMacosGenesisReleaseEnvelope(artifactDirectory, candidateApplication));
  return verifyEnvelope(input.artifactDirectory, input.candidateApplication);
}

export async function runMacosGenesisVerifierCli(arguments_, dependencies = {}) {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  if (arguments_.length !== 2 || arguments_.some((argument) => !isAbsolute(argument))) {
    stderr.write("expected absolute genesis artifact and loose candidate paths\n");
    return 1;
  }
  try {
    await verifyMacosGenesisRelease(
      { artifactDirectory: arguments_[0], candidateApplication: arguments_[1] },
      dependencies,
    );
    stdout.write("macOS genesis release envelope verified\n");
    return 0;
  } catch {
    stderr.write("macOS genesis release verification failed\n");
    return 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runMacosGenesisVerifierCli(process.argv.slice(2));
}
