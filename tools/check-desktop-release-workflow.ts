#!/usr/bin/env tsx

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

type Mapping = Record<string, unknown>;

function mapping(value: unknown, label: string, issues: string[]): Mapping {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    issues.push(`${label} must be a mapping`);
    return {};
  }
  return value as Mapping;
}

function scalar(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function steps(job: Mapping): Mapping[] {
  return Array.isArray(job.steps)
    ? job.steps.filter(
        (step): step is Mapping =>
          step !== null && typeof step === "object" && !Array.isArray(step),
      )
    : [];
}

function runs(job: Mapping): string[] {
  return steps(job).flatMap((step) => (typeof step.run === "string" ? [step.run] : []));
}

function namedStep(job: Mapping, name: string): Mapping | undefined {
  return steps(job).find((step) => step.name === name);
}

function countShellLine(script: string, expected: string): number {
  return script.split(/\r?\n/u).filter((line) => line.trim() === expected).length;
}

function exactPermissions(
  value: unknown,
  expected: Mapping,
  label: string,
  issues: string[],
): void {
  const permissions = mapping(value, `${label} permissions`, issues);
  const keys = Object.keys(permissions).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    expectedKeys.some((key) => permissions[key] !== expected[key])
  ) {
    issues.push(`${label} permissions are not least-privilege`);
  }
}

function requireQueue(
  concurrencyValue: unknown,
  group: string,
  label: string,
  issues: string[],
): void {
  const concurrency = mapping(concurrencyValue, `${label} concurrency`, issues);
  if (
    concurrency.group !== group ||
    concurrency["cancel-in-progress"] !== false ||
    concurrency.queue !== "max"
  ) {
    issues.push(`${label} must use non-cancelling ${group} concurrency with queue:max`);
  }
}

function checkCheckouts(source: string, workflow: Mapping, label: string, issues: string[]): void {
  const jobs = mapping(workflow.jobs, `${label}.jobs`, issues);
  for (const [jobName, rawJob] of Object.entries(jobs)) {
    const job = mapping(rawJob, `${label}.jobs.${jobName}`, issues);
    for (const step of steps(job)) {
      if (typeof step.uses === "string" && step.uses.startsWith("actions/checkout@")) {
        const withInputs = mapping(step.with, `${label}.${jobName}.checkout.with`, issues);
        if (withInputs["persist-credentials"] !== false)
          issues.push(`${label} checkout credentials must never persist`);
      }
    }
  }
  for (const run of Object.values(jobs).flatMap((raw) => runs(mapping(raw, label, issues)))) {
    if (run.includes("${{")) issues.push(`${label} run scripts must receive contexts through env`);
  }
  if (source.includes("github.event.inputs") && !source.includes("DISPATCH_TAG_INPUT:"))
    issues.push("manual release inputs must be routed through step environment variables");
}

export function inspectDesktopReleaseWorkflows(
  releaseSource: string,
  desktopSource: string,
  versionSource: string,
): string[] {
  const issues: string[] = [];
  let release: Mapping;
  let desktop: Mapping;
  let version: Mapping;
  try {
    release = mapping(parse(releaseSource), "release workflow", issues);
    desktop = mapping(parse(desktopSource), "desktop workflow", issues);
    version = mapping(parse(versionSource), "version workflow", issues);
  } catch {
    return ["release workflows must be valid YAML"];
  }

  if (
    releaseSource.includes("desktop-release:transaction --") ||
    desktopSource.includes("desktop-release:transaction --")
  ) {
    issues.push("release transaction commands must not pass a pnpm argument separator");
  }

  const releaseOn = mapping(release.on, "release.on", issues);
  if (!("push" in releaseOn) || !("workflow_dispatch" in releaseOn))
    issues.push("release.yml must remain the tag/manual coordinator");
  const desktopOn = mapping(desktop.on, "desktop.on", issues);
  if (Object.keys(desktopOn).length !== 1 || !("workflow_call" in desktopOn))
    issues.push("desktop-release.yml must be workflow_call-only");
  const workflowCall = mapping(desktopOn.workflow_call, "desktop.workflow_call", issues);
  const inputs = mapping(workflowCall.inputs, "desktop.workflow_call.inputs", issues);
  for (const input of [
    "tag",
    "npm_version",
    "desktop_version",
    "commit",
    "draft_id",
    "mode",
    "draft_body_sha256",
    "npm_integrity",
    "npm_attestation_url",
    "baseline_tag",
  ]) {
    if (!(input in inputs)) issues.push(`desktop workflow_call is missing ${input}`);
  }
  const workflowCallSecrets = mapping(
    workflowCall.secrets,
    "desktop.workflow_call.secrets",
    issues,
  );
  const requiredSigningSecrets = [
    "CSC_LINK",
    "CSC_KEY_PASSWORD",
    "APPLE_API_KEY_ID",
    "APPLE_API_ISSUER",
    "APPLE_API_KEY_P8_BASE64",
  ];
  for (const secret of requiredSigningSecrets) {
    const declaration = mapping(
      workflowCallSecrets[secret],
      `desktop.workflow_call.secrets.${secret}`,
      issues,
    );
    if (declaration.required !== false)
      issues.push(`desktop workflow_call must declare environment secret ${secret}`);
  }

  requireQueue(release.concurrency, "stable-desktop-coordinator", "release coordinator", issues);
  requireQueue(desktop.concurrency, "stable-desktop", "desktop release", issues);
  requireQueue(version.concurrency, "version-pr", "version dispatcher", issues);
  checkCheckouts(releaseSource, release, "release", issues);
  checkCheckouts(desktopSource, desktop, "desktop", issues);
  checkCheckouts(versionSource, version, "version", issues);

  const releaseJobs = mapping(release.jobs, "release.jobs", issues);
  const smoke = mapping(releaseJobs.smoke, "release.jobs.smoke", issues);
  const npmPublish = mapping(releaseJobs["publish-npm"], "release.jobs.publish-npm", issues);
  const npmVerify = mapping(
    releaseJobs["verify-npm-publication"],
    "release.jobs.verify-npm-publication",
    issues,
  );
  const draft = mapping(
    releaseJobs["prepare-release-draft"],
    "release.jobs.prepare-release-draft",
    issues,
  );
  const desktopCall = mapping(
    releaseJobs["desktop-release"],
    "release.jobs.desktop-release",
    issues,
  );
  const packageOnly = mapping(
    releaseJobs["publish-package-only-release"],
    "release.jobs.publish-package-only-release",
    issues,
  );

  exactPermissions(
    npmPublish.permissions,
    { actions: "read", contents: "read", "id-token": "write" },
    "npm publish",
    issues,
  );
  exactPermissions(
    npmVerify.permissions,
    { actions: "read", contents: "read" },
    "npm verification",
    issues,
  );
  const expectedNpmEnvironment =
    "${{ needs.parse-tag.outputs.package == 'cycling-coach' && needs.parse-tag.outputs.desktop_enabled == 'true' && 'npm-production' || '' }}";
  if (npmPublish.environment !== expectedNpmEnvironment)
    issues.push("desktop npm publication must use the conditional protected environment");
  if (!scalar(npmVerify.needs).includes("publish-npm") || "environment" in npmVerify)
    issues.push("no-OIDC npm verification must follow publication outside a protected environment");

  const smokeOutputs = mapping(smoke.outputs, "smoke outputs", issues);
  for (const output of [
    "artifact_id",
    "artifact_digest",
    "artifact_name",
    "workflow_run_attempt",
    "primary_filename",
    "primary_sha512",
    "alias_filename",
    "alias_sha512",
  ]) {
    if (!(output in smokeOutputs)) issues.push(`immutable npm preparation is missing ${output}`);
  }
  const npmPublishOutputs = mapping(npmPublish.outputs, "npm publish outputs", issues);
  for (const output of [
    "published_new",
    "publication_run_id",
    "publication_run_attempt",
    "publication_ref",
    "publication_event_name",
    "publication_commit",
  ]) {
    if (!(output in npmPublishOutputs)) issues.push(`npm publication tuple is missing ${output}`);
  }
  const npmVerifyOutputs = mapping(npmVerify.outputs, "npm verification outputs", issues);
  if (
    npmVerifyOutputs.npm_integrity !== "${{ steps.verify.outputs.npm_integrity }}" ||
    npmVerifyOutputs.npm_attestation_url !== "${{ steps.verify.outputs.npm_attestation_url }}"
  ) {
    issues.push("verified npm integrity and attestation URL must be exposed as job outputs");
  }

  const publishText = runs(npmPublish).join("\n");
  const verifyText = runs(npmVerify).join("\n");
  const smokeText = runs(smoke).join("\n");
  const publishSteps = steps(npmPublish);
  if (
    publishSteps.some(
      (step) =>
        typeof step.uses === "string" &&
        (step.uses.startsWith("actions/checkout@") || step.uses.startsWith("pnpm/action-setup@")),
    ) ||
    /(?:pnpm|npm)\s+(?:install|pack|run)|package:mac|\bbuild\b/u.test(publishText)
  ) {
    issues.push(
      "OIDC publication must not checkout code, install dependencies, build, pack, or run scripts",
    );
  }
  if (
    !releaseSource.includes("actions/upload-artifact@") ||
    (releaseSource.match(/actions\/download-artifact@[^\n]+# v8/gu) ?? []).length < 2 ||
    (releaseSource.match(/artifact-ids:/gu) ?? []).length < 2 ||
    (releaseSource.match(/digest-mismatch: error/gu) ?? []).length < 2
  ) {
    issues.push("npm prepare, publish, and verify must reuse one digest-checked Actions artifact");
  }
  if (
    (publishText.match(/npm publish/gu) ?? []).length !== 2 ||
    (publishText.match(/--registry=https:\/\/registry\.npmjs\.org\//gu) ?? []).length < 4 ||
    (publishText.match(/--provenance/gu) ?? []).length !== 2 ||
    (publishText.match(/--ignore-scripts/gu) ?? []).length !== 2
  ) {
    issues.push(
      "both npm identities must publish exact tarballs through the explicit public registry",
    );
  }
  if (
    !smokeText.includes('npm pack "$ALIAS_DIR/extract/package"') ||
    smokeText.includes("tar -czf") ||
    !publishText.includes("PUBLISHED_INTEGRITY") ||
    !publishText.includes(".dist.integrity")
  ) {
    issues.push("alias publication must reuse deterministic prepared bytes and exact integrity");
  }
  if (
    (publishText.match(/refs\/tags\/\$RELEASE_TAG/gu) ?? []).length !== 2 ||
    !publishText.includes('"$GITHUB_SHA" != "$EXPECTED_COMMIT"') ||
    !publishText.includes('"$GITHUB_SHA" != "$RELEASE_COMMIT"') ||
    !smokeText.includes(".version == $version") ||
    !publishText.includes(".version == $version")
  ) {
    issues.push("first npm publication must bind exact tag, commit, package name, and version");
  }
  if (
    (verifyText.match(/npm audit signatures/gu) ?? []).length !== 1 ||
    (verifyText.match(/verify-npm-provenance/gu) ?? []).length !== 1 ||
    !verifyText.includes("--workflow .github/workflows/release.yml") ||
    !verifyText.includes(".dist.integrity") ||
    !verifyText.includes(".dist.attestations.url") ||
    verifyText.includes("._attestations") ||
    releaseSource.includes(".gitHead")
  ) {
    issues.push(
      "no-OIDC verification must bind public bytes, signatures, and exact signed provenance",
    );
  }
  if (
    !verifyText.includes("PUBLICATION_RUN_ATTEMPT") ||
    !verifyText.includes("/actions/runs/$PUBLICATION_RUN_ID/attempts/$PUBLICATION_RUN_ATTEMPT") ||
    verifyText.includes("$GITHUB_RUN_ATTEMPT") ||
    verifyText.includes("$WORKFLOW_RUN_ATTEMPT") ||
    !verifyText.includes("PUBLICATION_REF") ||
    !verifyText.includes("PUBLICATION_EVENT_NAME")
  ) {
    issues.push("npm verification must use the successful publication attempt tuple on reruns");
  }
  const canonicalUrl = verifyText.indexOf("EXPECTED_ATTESTATION_URL=");
  const fetchUrl = verifyText.indexOf("curl --fail-with-body");
  if (
    canonicalUrl === -1 ||
    fetchUrl <= canonicalUrl ||
    !verifyText.includes('test "$OBSERVED_ATTESTATION_URL" = "$EXPECTED_ATTESTATION_URL"')
  )
    issues.push("npm attestation URL must be canonicalized before network fetch");

  exactPermissions(draft.permissions, { contents: "write" }, "draft preparation", issues);
  if (
    !scalar(draft.needs).includes("verify-npm-publication") ||
    !scalar(packageOnly.needs).includes("verify-npm-publication") ||
    !scalar(desktopCall.needs).includes("verify-npm-publication")
  ) {
    issues.push("GitHub release paths must wait for verified npm publication");
  }
  if (
    !releaseSource.includes("--json body,databaseId,isDraft,isPrerelease,tagName") ||
    !releaseSource.includes('"$IS_PRERELEASE" != "false"')
  ) {
    issues.push("stable desktop draft preparation must reject prereleases");
  }
  const desktopGate =
    "${{ needs.parse-tag.outputs.package == 'cycling-coach' && needs.parse-tag.outputs.desktop_enabled == 'true' }}";
  if (draft.if !== desktopGate || desktopCall.if !== desktopGate)
    issues.push("desktop transaction must use the frozen coordinator opt-in decision");
  if (desktopCall.uses !== "./.github/workflows/desktop-release.yml")
    issues.push("release.yml must coordinate the reusable desktop workflow");
  exactPermissions(
    desktopCall.permissions,
    { actions: "read", contents: "write" },
    "desktop reusable call",
    issues,
  );
  const callWith = mapping(desktopCall.with, "desktop call inputs", issues);
  if (
    callWith.npm_version !== "${{ needs.parse-tag.outputs.version }}" ||
    callWith.desktop_version !== "${{ needs.parse-tag.outputs.desktop_version }}" ||
    callWith.npm_integrity !== "${{ needs.verify-npm-publication.outputs.npm_integrity }}" ||
    callWith.npm_attestation_url !==
      "${{ needs.verify-npm-publication.outputs.npm_attestation_url }}"
  ) {
    issues.push("desktop call must consume frozen version authorities and verified npm outputs");
  }

  const packageOnlyText = scalar(packageOnly);
  if (
    packageOnly.if !==
      "${{ needs.parse-tag.outputs.package != 'cycling-coach' || needs.parse-tag.outputs.desktop_enabled != 'true' }}" ||
    !packageOnlyText.includes("gh release view") ||
    !packageOnlyText.includes("Leaving it untouched") ||
    !packageOnlyText.includes("gh release create") ||
    packageOnlyText.includes("--draft") ||
    packageOnlyText.includes("--latest=false")
  ) {
    issues.push(
      "disabled desktop releases must retain the package-only create-normal-or-leave-existing behavior",
    );
  }
  const parseTag = mapping(releaseJobs["parse-tag"], "release.jobs.parse-tag", issues);
  const parseOutputs = mapping(parseTag.outputs, "parse-tag outputs", issues);
  if (
    parseOutputs.desktop_enabled !== "${{ steps.parse.outputs.desktop_enabled }}" ||
    parseOutputs.desktop_version !== "${{ steps.parse.outputs.desktop_version }}" ||
    !releaseSource.includes('git show "$COMMIT:apps/desktop/package.json"') ||
    !releaseSource.includes('echo "desktop_version=$DESKTOP_VERSION" >> "$GITHUB_OUTPUT"') ||
    (releaseSource.match(/vars\.ENABLE_DESKTOP_MACOS_RELEASE/gu) ?? []).length !== 1
  ) {
    issues.push("desktop opt-in and version authority must be read once and frozen by parse-tag");
  }

  const desktopJobs = mapping(desktop.jobs, "desktop.jobs", issues);
  const sign = mapping(desktopJobs["sign-macos"], "desktop.jobs.sign-macos", issues);
  const verify = mapping(
    desktopJobs["verify-macos-envelope"],
    "desktop.jobs.verify-macos-envelope",
    issues,
  );
  const stage = mapping(
    desktopJobs["stage-private-draft"],
    "desktop.jobs.stage-private-draft",
    issues,
  );
  const publish = mapping(desktopJobs["publish-assets"], "desktop.jobs.publish-assets", issues);
  const promote = mapping(desktopJobs["promote-latest"], "desktop.jobs.promote-latest", issues);
  const roundTrip = mapping(
    desktopJobs["verify-production-update"],
    "desktop.jobs.verify-production-update",
    issues,
  );
  const activate = mapping(
    desktopJobs["activate-release"],
    "desktop.jobs.activate-release",
    issues,
  );
  const compensate = mapping(
    desktopJobs["compensate-publication"],
    "desktop.jobs.compensate-publication",
    issues,
  );
  exactPermissions(sign.permissions, { contents: "read" }, "macOS signing", issues);
  exactPermissions(
    verify.permissions,
    { actions: "read", contents: "read" },
    "macOS verification",
    issues,
  );
  exactPermissions(
    stage.permissions,
    { actions: "read", contents: "write" },
    "private draft staging",
    issues,
  );
  exactPermissions(
    publish.permissions,
    { actions: "read", contents: "write" },
    "asset publication",
    issues,
  );
  exactPermissions(
    promote.permissions,
    { actions: "read", contents: "write" },
    "latest promotion",
    issues,
  );
  exactPermissions(
    roundTrip.permissions,
    { actions: "read", contents: "read" },
    "production update verification",
    issues,
  );
  exactPermissions(
    activate.permissions,
    { actions: "read", contents: "write" },
    "release activation",
    issues,
  );
  exactPermissions(
    compensate.permissions,
    { actions: "read", contents: "write" },
    "release compensation",
    issues,
  );
  const signingSecrets = [
    "CSC_LINK",
    "CSC_KEY_PASSWORD",
    "APPLE_API_KEY",
    "APPLE_API_KEY_ID",
    "APPLE_API_ISSUER",
    "APPLE_API_KEY_P8_BASE64",
    "ENDURAGENT_DEVELOPER_ID_IDENTITY",
  ];
  const nonSigningDesktopText = Object.entries(desktopJobs)
    .filter(([jobName]) => jobName !== "sign-macos")
    .map(([jobName, rawJob]) => scalar(mapping(rawJob, `desktop.jobs.${jobName}`, issues)))
    .join("\n");
  for (const secret of signingSecrets) {
    if (new RegExp(`\\b${secret}\\b`, "u").test(nonSigningDesktopText))
      issues.push(`signing secret ${secret} escaped the signing job`);
  }
  if (sign.environment !== "desktop-macos-signing")
    issues.push("signing secrets must come from desktop-macos-signing environment");
  if (
    Object.entries(desktopJobs).some(
      ([jobName, rawJob]) =>
        jobName !== "sign-macos" &&
        mapping(rawJob, `desktop.jobs.${jobName}`, issues).environment === "desktop-macos-signing",
    )
  ) {
    issues.push("desktop-macos-signing environment must remain exclusive to the signing job");
  }
  if (
    stage.environment !== "desktop-macos-publication" ||
    publish.environment !== "desktop-macos-publication" ||
    promote.environment !== "desktop-macos-latest" ||
    activate.environment !== "desktop-macos-latest" ||
    compensate.environment !== "desktop-macos-latest"
  )
    issues.push("write-authority desktop jobs must use protected environments");
  if (!scalar(stage.needs).includes("verify-macos-envelope") || verify.needs !== "sign-macos")
    issues.push("independent macOS verification must follow signing before private staging");
  const publishRun = runs(publish).join("\n");
  const promoteRun = runs(promote).join("\n");
  const roundTripRun = runs(roundTrip).join("\n");
  const activateRun = runs(activate).join("\n");
  const compensateRun = runs(compensate).join("\n");
  const observeIndex = publishRun.indexOf("desktop-release:transaction observe");
  const publicationIndex = publishRun.indexOf("desktop-release:transaction publish");
  if (
    !scalar(publish.needs).includes("stage-private-draft") ||
    observeIndex === -1 ||
    publicationIndex <= observeIndex ||
    !publishRun.includes('--expected-latest-id "$EXPECTED_LATEST_ID"') ||
    !publishRun.includes('--expected-latest-tag "$EXPECTED_LATEST_TAG"') ||
    !publishRun.includes('--expected-latest-metadata-sha256 "$EXPECTED_LATEST_METADATA_SHA256"') ||
    scalar(mapping(publish.outputs, "desktop publish outputs", issues).latest_id) !==
      "${{ steps.observe.outputs.latest_id }}"
  ) {
    issues.push("public desktop publication must bind latest before provisional publication");
  }
  if (
    !scalar(promote.needs).includes("publish-assets") ||
    !promoteRun.includes("desktop-release:transaction promote") ||
    !promoteRun.includes('--expected-latest-id "$EXPECTED_LATEST_ID"')
  ) {
    issues.push("desktop latest promotion must compare-and-swap the observed release");
  }
  const roundTripNeeds = scalar(roundTrip.needs);
  if (
    roundTrip.if !== "${{ inputs.mode == 'steady' }}" ||
    !roundTripNeeds.includes("sign-macos") ||
    !roundTripNeeds.includes("promote-latest") ||
    !roundTripRun.includes("desktop-release:transaction public-envelope") ||
    !roundTripRun.includes("test:macos-update-roundtrip") ||
    !roundTripRun.includes('"$RUNNER_TEMP/desktop-baseline"') ||
    !roundTripRun.includes('"$CANDIDATE_ENVELOPE"') ||
    !roundTripRun.includes('"$EVIDENCE"') ||
    !scalar(roundTrip).includes("desktop-update-evidence-") ||
    !scalar(roundTrip).includes("needs.sign-macos.outputs.baseline_version")
  ) {
    issues.push("steady publication must pass a native production-feed N-to-N+1 round trip");
  }
  const activateCondition = scalar(activate.if).replace(/\s+/gu, " ");
  const activateNeeds = scalar(activate.needs);
  if (
    !activateNeeds.includes("publish-assets") ||
    !activateNeeds.includes("promote-latest") ||
    !activateNeeds.includes("verify-production-update") ||
    !activateCondition.includes("always()") ||
    !activateCondition.includes("needs.publish-assets.result == 'success'") ||
    !activateCondition.includes("needs.promote-latest.result == 'success'") ||
    !activateCondition.includes("inputs.mode == 'genesis'") ||
    !activateCondition.includes("needs.verify-production-update.result == 'skipped'") ||
    !activateCondition.includes("inputs.mode == 'steady'") ||
    !activateCondition.includes("needs.verify-production-update.result == 'success'") ||
    !activateRun.includes("desktop-release:transaction activate") ||
    !activateRun.includes("packages/cycling-coach/CHANGELOG.md")
  ) {
    issues.push("general-availability activation must follow the mode-specific acceptance gate");
  }
  const compensateCondition = scalar(compensate.if).replace(/\s+/gu, " ");
  const compensateNeeds = scalar(compensate.needs);
  if (
    !compensateNeeds.includes("activate-release") ||
    !compensateCondition.includes("always()") ||
    !compensateCondition.includes("needs.publish-assets.outputs.latest_id != ''") ||
    !compensateCondition.includes("needs.activate-release.result != 'success'") ||
    !compensateRun.includes("desktop-release:transaction compensate") ||
    !compensateRun.includes('--expected-latest-id "$EXPECTED_LATEST_ID"') ||
    !compensateRun.includes('--expected-latest-tag "$EXPECTED_LATEST_TAG"') ||
    !compensateRun.includes('--expected-latest-metadata-sha256 "$EXPECTED_LATEST_METADATA_SHA256"')
  ) {
    issues.push(
      "failed desktop activation must restore the observed latest and withdraw the candidate",
    );
  }
  const signingSteps = steps(sign);
  const signingStep = namedStep(sign, "Build signed and notarized macOS envelope");
  const signingInstallIndex = signingSteps.findIndex(
    (step) => step.run === "pnpm install --frozen-lockfile",
  );
  const signingWorkspaceBuildIndex = signingSteps.findIndex((step) => step.run === "pnpm -r build");
  const signingPackageIndex = signingSteps.indexOf(signingStep ?? {});
  const signingEnvironment = mapping(signingStep?.env, "macOS signing step environment", issues);
  const signingRun = typeof signingStep?.run === "string" ? signingStep.run : "";
  const keyCleanupStep = namedStep(sign, "Remove temporary notarization key");
  const keyCleanupRun = typeof keyCleanupStep?.run === "string" ? keyCleanupStep.run : "";
  const keyCreation = signingRun.indexOf(
    'printf \'%s\' "$APPLE_API_KEY_P8_BASE64" | base64 -D > "$APPLE_API_KEY"',
  );
  const privateUmask = signingRun.indexOf("umask 077");
  if (
    signingInstallIndex === -1 ||
    signingWorkspaceBuildIndex <= signingInstallIndex ||
    signingWorkspaceBuildIndex >= signingPackageIndex
  ) {
    issues.push("macOS signing must build workspace dependencies before packaging");
  }
  if (
    countShellLine(signingRun, `for secret_name in ${requiredSigningSecrets.join(" ")}; do`) !==
      1 ||
    !signingRun.includes("Required desktop signing secret $secret_name is unavailable")
  ) {
    issues.push("macOS signing must fail closed when an environment secret is unavailable");
  }
  if (
    (signingRun.match(/pnpm --filter @enduragent\/desktop package:mac:genesis(?:\s|$)/gu) ?? [])
      .length !== 1 ||
    (signingRun.match(/pnpm --filter @enduragent\/desktop package:mac(?:\s|$)/gu) ?? []).length !==
      1 ||
    countShellLine(signingRun, 'case "$RELEASE_MODE" in') !== 1 ||
    !signingRun.includes("genesis)") ||
    !signingRun.includes("steady)") ||
    signingEnvironment.RELEASE_MODE !== "${{ inputs.mode }}" ||
    signingEnvironment.ENDURAGENT_MACOS_GENESIS_VERSION !== "${{ inputs.desktop_version }}" ||
    !desktopSource.includes('--npm-version "$NPM_VERSION"') ||
    !desktopSource.includes('--desktop-version "$DESKTOP_VERSION"') ||
    !desktopSource.includes('--candidate-tag "$RELEASE_TAG"') ||
    nonSigningDesktopText.includes("package:mac")
  ) {
    issues.push("signing must dispatch explicit genesis and steady packaging modes");
  }
  if (
    keyCreation === -1 ||
    privateUmask === -1 ||
    privateUmask > keyCreation ||
    signingEnvironment.APPLE_API_KEY !== "${{ runner.temp }}/AuthKey.p8" ||
    keyCleanupStep?.if !== "${{ always() }}" ||
    signingSteps.indexOf(keyCleanupStep ?? {}) <= signingSteps.indexOf(signingStep ?? {}) ||
    countShellLine(keyCleanupRun, 'rm -f "$RUNNER_TEMP/AuthKey.p8"') !== 1
  ) {
    issues.push("temporary notarization key must be created privately and always removed");
  }
  const independentStep = namedStep(verify, "Independently verify signed updater envelope");
  const independentEnvironment = mapping(
    independentStep?.env,
    "independent macOS verification step environment",
    issues,
  );
  const independentRun = typeof independentStep?.run === "string" ? independentStep.run : "";
  const transactionVerification = independentRun.indexOf("desktop-release:transaction verify");
  const publicEnvelope = independentRun.indexOf("desktop-release:transaction public-envelope");
  const genesisVerification = independentRun.indexOf(
    "verify:mac-genesis-release --",
    publicEnvelope,
  );
  const steadyVerification = independentRun.indexOf("verify:mac-release --", publicEnvelope);
  const genesisCase = independentRun.slice(
    independentRun.indexOf("genesis)", publicEnvelope),
    independentRun.indexOf(";;", independentRun.indexOf("genesis)", publicEnvelope)),
  );
  const steadyCase = independentRun.slice(
    independentRun.indexOf("steady)", publicEnvelope),
    independentRun.indexOf(";;", independentRun.indexOf("steady)", publicEnvelope)),
  );
  if (
    transactionVerification === -1 ||
    publicEnvelope <= transactionVerification ||
    genesisVerification <= publicEnvelope ||
    steadyVerification <= publicEnvelope ||
    independentEnvironment.RELEASE_MODE !== "${{ inputs.mode }}" ||
    countShellLine(independentRun, 'case "$RELEASE_MODE" in') !== 1 ||
    (independentRun.match(/verify:mac-genesis-release --/gu) ?? []).length !== 1 ||
    (independentRun.match(/verify:mac-release --/gu) ?? []).length !== 1 ||
    (independentRun.slice(publicEnvelope).match(/"\$PUBLIC_ENVELOPE"/gu) ?? []).length !== 3 ||
    !genesisCase.includes('"$PUBLIC_ENVELOPE"') ||
    !genesisCase.includes('"$CANDIDATE_APP"') ||
    genesisCase.includes("$INDEPENDENT_BASELINE_APP") ||
    !steadyCase.includes('"$PUBLIC_ENVELOPE"') ||
    !steadyCase.includes('"$INDEPENDENT_BASELINE_APP"') ||
    !steadyCase.includes('"$CANDIDATE_APP"') ||
    desktopSource.split("\\(FA494ACVTF\\)$").length - 1 !== 3 ||
    countShellLine(independentRun, 'test "$INDEPENDENT_CDHASH" = "$CANDIDATE_CDHASH"') !== 1 ||
    countShellLine(
      independentRun,
      'test "$INDEPENDENT_CODE_DIRECTORY_SHA256" = "$CANDIDATE_CODE_DIRECTORY_SHA256"',
    ) !== 1 ||
    countShellLine(independentRun, 'test "$INDEPENDENT_SIGNING_IDENTITY" = "$SIGNING_IDENTITY"') !==
      1
  ) {
    issues.push(
      "mode-specific native verification must consume a signed exact-four public envelope",
    );
  }
  if (
    (
      desktopSource.match(
        /SIGNING_RUN_ATTEMPT: \$\{\{ needs\.sign-macos\.outputs\.workflow_run_attempt \}\}/gu,
      ) ?? []
    ).length !== 8 ||
    desktopSource.includes("SIGNING_RUN_ATTEMPT: ${{ github.run_attempt }}") ||
    !independentRun.includes('--workflow-run-attempt "$SIGNING_RUN_ATTEMPT"')
  ) {
    issues.push("desktop verification must bind the successful signing attempt on reruns");
  }
  if (
    (desktopSource.match(/actions\/download-artifact@[^\n]+# v8/gu) ?? []).length !== 8 ||
    (desktopSource.match(/digest-mismatch: error/gu) ?? []).length !== 8 ||
    !desktopSource.includes("artifact_id: ${{ steps.sealed-artifact.outputs.artifact-id }}") ||
    !desktopSource.includes(
      "artifact_digest: ${{ steps.sealed-artifact.outputs.artifact-digest }}",
    ) ||
    !desktopSource.includes(
      "baseline_artifact_id: ${{ steps.baseline-artifact.outputs.artifact-id }}",
    ) ||
    !desktopSource.includes(
      "baseline_artifact_digest: ${{ steps.baseline-artifact.outputs.artifact-digest }}",
    )
  ) {
    issues.push("desktop consumers must bind the exact digest-checked signing artifact");
  }

  const versionJobs = mapping(version.jobs, "version.jobs", issues);
  const versionJob = mapping(versionJobs["version-pr"], "version.jobs.version-pr", issues);
  const versionText = runs(versionJob).join("\n");
  if (
    !versionText.includes('git rev-parse "refs/tags/$TAG^{commit}"') ||
    !versionText.includes('"$TAG_COMMIT" != "$RELEASE_COMMIT"') ||
    !versionText.includes('gh workflow run release.yml --ref "$TAG" -f tag="$TAG"') ||
    !versionText.includes("for attempt in $(seq 1 6)") ||
    versionText.includes("Tag $TAG already on origin — skipping")
  ) {
    issues.push(
      "version dispatcher must verify existing tags and retry exact-tag release dispatch",
    );
  }
  return issues;
}

export function main(): void {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const issues = inspectDesktopReleaseWorkflows(
    readFileSync(resolve(root, ".github/workflows/release.yml"), "utf8"),
    readFileSync(resolve(root, ".github/workflows/desktop-release.yml"), "utf8"),
    readFileSync(resolve(root, ".github/workflows/version-pr.yml"), "utf8"),
  );
  if (issues.length > 0) throw new TypeError(issues.map((issue) => `- ${issue}`).join("\n"));
  process.stdout.write("Desktop release workflow structure verified\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
