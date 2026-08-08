import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createMacosGenesisReleasePlan,
  notarizeMacosDmg,
  promoteMacosReleaseEnvelope,
  requireNotarizationCredentials,
  sealMacosReleaseMetadata,
} from "./macos-release-plan.mjs";

export async function runMacosGenesisRelease(input, dependencies = {}) {
  const plan = await createMacosGenesisReleasePlan(input, dependencies);
  if (input.genesisVersion !== plan.version) {
    throw new TypeError("macOS genesis release version acknowledgement is invalid");
  }
  const notarizationCredentials = requireNotarizationCredentials(
    dependencies.environment ?? process.env,
  );
  const verification = await import("./verify-macos-release.mjs");
  const build = dependencies.build ?? (await import("electron-builder")).build;
  const artifacts = await build(plan.builderOptions);
  const application = join(plan.builderOptions.projectDir, "dist/mac-arm64/Enduragent.app");
  const verifyPackageLayout =
    dependencies.verifyPackageLayout ??
    (await import("./verify-package-layout.mjs")).verifyPackageLayout;
  await verifyPackageLayout(application, {
    desktopRoot: plan.builderOptions.projectDir,
    release: {
      version: plan.version,
      feedUrl: plan.feedUrl,
    },
  });
  const verifyCandidateApplication =
    dependencies.verifyCandidateApplication ??
    ((candidate, options) =>
      verification.verifyMacosReleaseCandidateApplication(candidate, options, {
        executeFile: dependencies.executeFile,
      }));
  await verifyCandidateApplication(application, { candidateVersion: plan.version });
  const dmgPath = join(plan.builderOptions.projectDir, "dist", plan.artifactNames.dmg);
  await notarizeMacosDmg(dmgPath, notarizationCredentials, {
    notarize: dependencies.notarize,
  });
  const verifyDmg =
    dependencies.verifyDmg ??
    ((path) =>
      verification.verifyMacosDmg(path, {
        executeFile: dependencies.executeFile,
      }));
  await verifyDmg(dmgPath);
  const sealReleaseMetadata = dependencies.sealReleaseMetadata ?? sealMacosReleaseMetadata;
  await sealReleaseMetadata(plan);
  const verifyEnvelope = (artifactDirectory) =>
    verification.verifyMacosGenesisReleaseEnvelope(
      artifactDirectory,
      application,
      {
        repositoryRoot: input.repositoryRoot,
        readVersionFile: dependencies.readFile,
      },
      {
        executeFile: dependencies.executeFile,
        verifyCandidateApplication,
        verifyReleaseApplicationContents: dependencies.verifyReleaseApplicationContents,
        verifyReleaseArtifacts: dependencies.verifyReleaseArtifacts,
      },
    );
  const promoteReleaseEnvelope = dependencies.promoteReleaseEnvelope ?? promoteMacosReleaseEnvelope;
  const envelopePath = await promoteReleaseEnvelope(plan, verifyEnvelope);
  return { plan, artifacts, envelopePath };
}

async function main() {
  if (process.argv.length !== 2) throw new TypeError("arguments are not supported");
  const result = await runMacosGenesisRelease({
    feedUrl: process.env.ENDURAGENT_DESKTOP_UPDATE_URL,
    identity: process.env.ENDURAGENT_DEVELOPER_ID_IDENTITY,
    genesisVersion: process.env.ENDURAGENT_MACOS_GENESIS_VERSION,
  });
  process.stdout.write(`macOS genesis release envelope: ${result.envelopePath}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch {
    process.stderr.write("macOS genesis release build failed\n");
    process.exitCode = 1;
  }
}
