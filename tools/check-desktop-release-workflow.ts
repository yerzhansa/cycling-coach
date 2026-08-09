#!/usr/bin/env tsx

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

type Mapping = Record<string, unknown>;

const PROVISIONAL_RELEASE_BODY =
  "Desktop update validation is in progress. This release is not yet generally available.";

function mapping(value: unknown, label: string, issues: string[]): Mapping {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    issues.push(`${label} must be a mapping`);
    return {};
  }
  return value as Mapping;
}

function scalar(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? "");
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

function actionSteps(job: Mapping, action: string): Mapping[] {
  return steps(job).filter(
    (step) => typeof step.uses === "string" && step.uses.startsWith(`${action}@`),
  );
}

function countShellLine(script: string, expected: string): number {
  return script.split(/\r?\n/u).filter((line) => line.trim() === expected).length;
}

function exactKeys(value: Mapping, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function exactStringSet(value: unknown, expected: string[]): boolean {
  const actual = (Array.isArray(value) ? value.map(String) : [scalar(value)]).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((item, index) => item === wanted[index]);
}

function checkRecoveryOverlay(
  job: Mapping,
  label: string,
  expectedPaths: string[],
  requireAncestry: boolean,
  issues: string[],
): void {
  const jobSteps = steps(job);
  const checkoutIndex = jobSteps.findIndex(
    (step) => typeof step.uses === "string" && step.uses.startsWith("actions/checkout@"),
  );
  const recoveryStep = namedStep(
    job,
    expectedPaths.length === 1
      ? "Bind recovery transaction tooling"
      : "Bind recovery release tooling",
  );
  const recoveryIndex = jobSteps.indexOf(recoveryStep ?? {});
  const installIndex = jobSteps.findIndex((step) => step.run === "pnpm install --frozen-lockfile");
  const environment = mapping(recoveryStep?.env, `${label} recovery environment`, issues);
  const run = typeof recoveryStep?.run === "string" ? recoveryStep.run : "";
  const observedPaths =
    run.replaceAll("\\n", "\n").match(/\b(?:apps|packages|tools)\/[A-Za-z0-9_./@-]+/gu) ?? [];
  const expectedDiff = expectedPaths.join("\\n");
  const exactDiff =
    expectedPaths.length === 1
      ? run.includes(`test "$(git diff --cached --name-only)" = '${expectedPaths[0]}'`)
      : run.includes(`EXPECTED_RECOVERY_DIFF=$'${expectedDiff}'`) &&
        run.includes('test "$(git diff --cached --name-only)" = "$EXPECTED_RECOVERY_DIFF"');
  if (
    checkoutIndex === -1 ||
    recoveryIndex <= checkoutIndex ||
    installIndex <= recoveryIndex ||
    !exactKeys(environment, ["RELEASE_COMMIT", "RELEASE_TOOLING_COMMIT"]) ||
    environment.RELEASE_COMMIT !== "${{ inputs.commit }}" ||
    environment.RELEASE_TOOLING_COMMIT !== "${{ inputs.tooling_commit }}" ||
    countShellLine(run, 'test "$(git rev-parse HEAD)" = "$RELEASE_COMMIT"') !== 2 ||
    !run.includes('if [ "$RELEASE_TOOLING_COMMIT" = "$RELEASE_COMMIT" ]; then') ||
    !run.includes('git fetch --no-tags origin "$RELEASE_TOOLING_COMMIT"') ||
    (requireAncestry &&
      !run.includes('git merge-base --is-ancestor "$RELEASE_COMMIT" "$RELEASE_TOOLING_COMMIT"')) ||
    countShellLine(
      run,
      'git restore --source="$RELEASE_TOOLING_COMMIT" --staged --worktree -- \\',
    ) !== 1 ||
    !exactDiff ||
    !run.includes('test -z "$(git diff --name-only)"') ||
    !run.includes('test -z "$(git ls-files --others --exclude-standard)"') ||
    observedPaths.length !== expectedPaths.length * 2 ||
    observedPaths.some((path) => !expectedPaths.includes(path)) ||
    expectedPaths.some(
      (path) => observedPaths.filter((observedPath) => observedPath === path).length !== 2,
    )
  ) {
    issues.push(`${label} must overlay exactly ${expectedPaths.join(", ")}`);
  }
}

function exactPermissions(
  value: unknown,
  expected: Mapping,
  label: string,
  issues: string[],
): void {
  const permissions = mapping(value, `${label} permissions`, issues);
  if (
    !exactKeys(permissions, Object.keys(expected)) ||
    Object.entries(expected).some(([key, permission]) => permissions[key] !== permission)
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

function checkCheckouts(workflow: Mapping, label: string, issues: string[]): void {
  const jobs = mapping(workflow.jobs, `${label}.jobs`, issues);
  for (const [jobName, rawJob] of Object.entries(jobs)) {
    const job = mapping(rawJob, `${label}.jobs.${jobName}`, issues);
    for (const step of steps(job)) {
      if (typeof step.uses === "string" && step.uses.startsWith("actions/checkout@")) {
        const withInputs = mapping(step.with, `${label}.${jobName}.checkout.with`, issues);
        if (withInputs["persist-credentials"] !== false) {
          issues.push(`${label} checkout credentials must never persist`);
        }
      }
      if (typeof step.run === "string" && step.run.includes("${{")) {
        issues.push(`${label} run scripts must receive contexts through env`);
      }
    }
  }
}

function checkCoordinator(source: string, coordinator: Mapping, issues: string[]): void {
  const workflowOn = mapping(coordinator.on, "desktop coordinator.on", issues);
  if (Object.keys(workflowOn).length !== 1 || !("workflow_dispatch" in workflowOn)) {
    issues.push("desktop release coordinator must be workflow_dispatch-only");
  }
  const workflowDispatch = mapping(
    workflowOn.workflow_dispatch,
    "desktop coordinator.workflow_dispatch",
    issues,
  );
  const inputs = mapping(
    workflowDispatch.inputs,
    "desktop coordinator.workflow_dispatch.inputs",
    issues,
  );
  if (
    !exactKeys(inputs, [
      "tag",
      "desktop_mode",
      "desktop_baseline_tag",
      "recovery_tooling_tag",
      "recovery_source_run_id",
    ])
  ) {
    issues.push("desktop coordinator inputs must remain desktop-only");
  }
  const tagInput = mapping(inputs.tag, "desktop coordinator tag input", issues);
  const modeInput = mapping(inputs.desktop_mode, "desktop coordinator mode input", issues);
  const recoveryToolingTagInput = mapping(
    inputs.recovery_tooling_tag,
    "desktop coordinator recovery tooling tag input",
    issues,
  );
  const recoverySourceRunInput = mapping(
    inputs.recovery_source_run_id,
    "desktop coordinator recovery source run input",
    issues,
  );
  if (tagInput.required !== true || tagInput.type !== "string") {
    issues.push("desktop coordinator must require a string candidate tag");
  }
  if (
    modeInput.type !== "choice" ||
    modeInput.default !== "steady" ||
    scalar(modeInput.options) !== '["steady","genesis"]'
  ) {
    issues.push("desktop coordinator must expose only steady and genesis modes");
  }
  if (
    recoveryToolingTagInput.type !== "string" ||
    recoveryToolingTagInput.required !== false ||
    recoveryToolingTagInput.default !== ""
  ) {
    issues.push("desktop coordinator recovery tooling tag must be an optional string");
  }
  if (
    recoverySourceRunInput.type !== "string" ||
    recoverySourceRunInput.required !== false ||
    recoverySourceRunInput.default !== ""
  ) {
    issues.push("desktop coordinator recovery source run id must be an optional string");
  }
  if (coordinator["run-name"] !== "Desktop release coordinator ${{ inputs.tag }}") {
    issues.push("desktop coordinator run name must bind the candidate tag");
  }
  exactPermissions(coordinator.permissions, { contents: "read" }, "desktop coordinator", issues);
  requireQueue(
    coordinator.concurrency,
    "stable-desktop-coordinator",
    "desktop release coordinator",
    issues,
  );

  const jobs = mapping(coordinator.jobs, "desktop coordinator.jobs", issues);
  const bind = mapping(jobs["bind-release"], "desktop coordinator.jobs.bind-release", issues);
  const draft = mapping(
    jobs["prepare-release-draft"],
    "desktop coordinator.jobs.prepare-release-draft",
    issues,
  );
  const dispatch = mapping(
    jobs["dispatch-desktop-release"],
    "desktop coordinator.jobs.dispatch-desktop-release",
    issues,
  );
  exactPermissions(
    bind.permissions,
    { actions: "read", contents: "read" },
    "desktop candidate binding",
    issues,
  );
  exactPermissions(draft.permissions, { contents: "write" }, "desktop draft preparation", issues);
  exactPermissions(
    dispatch.permissions,
    { actions: "write", contents: "read" },
    "desktop child dispatcher",
    issues,
  );

  const bindOutputs = mapping(bind.outputs, "desktop coordinator bind outputs", issues);
  const expectedBindOutputs: Mapping = {
    tag: "${{ steps.bind.outputs.tag }}",
    desktop_version: "${{ steps.bind.outputs.desktop_version }}",
    commit: "${{ steps.bind.outputs.commit }}",
    workflow_ref: "${{ steps.bind.outputs.workflow_ref }}",
    tooling_commit: "${{ steps.bind.outputs.tooling_commit }}",
    mode: "${{ steps.bind.outputs.mode }}",
    baseline_tag: "${{ steps.bind.outputs.baseline_tag }}",
    source_run_id: "${{ steps.bind.outputs.source_run_id }}",
  };
  if (
    !exactKeys(bindOutputs, Object.keys(expectedBindOutputs)) ||
    Object.entries(expectedBindOutputs).some(([key, value]) => bindOutputs[key] !== value)
  ) {
    issues.push("desktop coordinator must freeze the candidate release tuple once");
  }
  const bindStep = namedStep(bind, "Bind desktop tag, version, and source commit");
  const bindEnvironment = mapping(bindStep?.env, "desktop candidate binding environment", issues);
  const bindRun = typeof bindStep?.run === "string" ? bindStep.run : "";
  if (
    bindEnvironment.RELEASE_TAG_INPUT !== "${{ inputs.tag }}" ||
    bindEnvironment.RECOVERY_TOOLING_TAG_INPUT !== "${{ inputs.recovery_tooling_tag }}" ||
    bindEnvironment.RECOVERY_SOURCE_RUN_ID_INPUT !== "${{ inputs.recovery_source_run_id }}" ||
    bindEnvironment.GH_TOKEN !== "${{ github.token }}" ||
    bindEnvironment.DESKTOP_ENABLED !== "${{ vars.ENABLE_DESKTOP_MACOS_RELEASE }}" ||
    bindEnvironment.WORKFLOW_REF !== "${{ github.ref }}" ||
    bindEnvironment.WORKFLOW_SHA !== "${{ github.sha }}" ||
    (source.match(/vars\.ENABLE_DESKTOP_MACOS_RELEASE/gu) ?? []).length !== 1 ||
    !bindRun.includes("test \"$DESKTOP_ENABLED\" = 'true'") ||
    !bindRun.includes(
      "printf '%s' \"$TAG\" | grep -Eq '^enduragent-desktop@(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$'",
    ) ||
    !bindRun.includes('VERSION="${TAG#enduragent-desktop@}"') ||
    !bindRun.includes('git fetch --force --no-tags origin "refs/tags/$TAG:refs/tags/$TAG"') ||
    !bindRun.includes('COMMIT=$(git rev-parse "refs/tags/$TAG^{commit}")') ||
    !bindRun.includes('test "$WORKFLOW_REF" = "refs/tags/$TAG"') ||
    !bindRun.includes('test "$WORKFLOW_SHA" = "$COMMIT"') ||
    !bindRun.includes('git show "$COMMIT:apps/desktop/package.json"') ||
    !bindRun.includes('if [ "$MANIFEST_VERSION" != "$VERSION" ]') ||
    !bindRun.includes('git merge-base --is-ancestor "$COMMIT" refs/remotes/origin/main') ||
    !bindRun.includes('echo "desktop_version=$VERSION" >> "$GITHUB_OUTPUT"')
  ) {
    issues.push(
      "desktop candidate tag must be stable enduragent-desktop SemVer bound to apps/desktop/package.json",
    );
  }
  if (
    !bindRun.includes("SOURCE_RUN_ID=none") ||
    !bindRun.includes('if [ -n "$RECOVERY_SOURCE_RUN_ID_INPUT" ]; then') ||
    !bindRun.includes(
      'if [ -z "$RECOVERY_TOOLING_TAG_INPUT" ] || [ "$MODE" != \'steady\' ]; then',
    ) ||
    !bindRun.includes("printf '%s' \"$RECOVERY_SOURCE_RUN_ID_INPUT\" | grep -Eq '^[1-9][0-9]*$'") ||
    !bindRun.includes('SOURCE_RUN_ID="$RECOVERY_SOURCE_RUN_ID_INPUT"') ||
    !bindRun.includes('echo "source_run_id=$SOURCE_RUN_ID" >> "$GITHUB_OUTPUT"')
  ) {
    issues.push(
      "desktop coordinator recovery source run must require a steady immutable recovery tag",
    );
  }
  if (
    !bindRun.includes(
      'SOURCE_RUN=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$SOURCE_RUN_ID")',
    ) ||
    !bindRun.includes(".github/workflows/desktop-release.yml") ||
    !bindRun.includes(".event')\" = 'workflow_dispatch'") ||
    !bindRun.includes(".status')\" = 'completed'") ||
    !bindRun.includes(".conclusion')\" = 'failure'") ||
    !bindRun.includes(".repository.full_name") ||
    !bindRun.includes("SOURCE_ATTEMPT=") ||
    !bindRun.includes('SOURCE_REVISION="${SOURCE_HEAD#"${TAG}-recovery."}"') ||
    !bindRun.includes('test "$SOURCE_HEAD" = "${TAG}-recovery.${SOURCE_REVISION}"') ||
    !bindRun.includes('test "$SOURCE_HEAD" != "$RECOVERY_TOOLING_TAG_INPUT"') ||
    !bindRun.includes(
      'test "$(git rev-parse "refs/tags/$SOURCE_HEAD^{commit}")" = "$SOURCE_SHA"',
    ) ||
    !bindRun.includes('git merge-base --is-ancestor "$COMMIT" "$SOURCE_SHA"') ||
    !bindRun.includes('git merge-base --is-ancestor "$SOURCE_SHA" "$TOOLING_COMMIT"') ||
    !bindRun.includes('git merge-base --is-ancestor "$SOURCE_SHA" refs/remotes/origin/main') ||
    !bindRun.includes(
      'SOURCE_JOBS=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$SOURCE_RUN_ID/jobs?per_page=100")',
    ) ||
    !bindRun.includes(
      "for required_job in sign-macos verify-macos-envelope stage-private-draft publish-assets; do",
    ) ||
    !bindRun.includes('.name == "activate-release" and .conclusion == "success"') ||
    !bindRun.includes(
      'SOURCE_ARTIFACTS=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$SOURCE_RUN_ID/artifacts?per_page=100")',
    ) ||
    !bindRun.includes(
      'for artifact_name in "desktop-release-$SOURCE_RUN_ID-$SOURCE_ATTEMPT" "desktop-baseline-$SOURCE_RUN_ID-$SOURCE_ATTEMPT"; do',
    ) ||
    !bindRun.includes("artifact cardinality") ||
    !bindRun.includes(".expired") ||
    !bindRun.includes("^sha256:[0-9a-f]{64}$") ||
    !bindRun.includes(".workflow_run.id") ||
    !bindRun.includes(".workflow_run.head_branch") ||
    !bindRun.includes(".workflow_run.head_sha")
  ) {
    issues.push(
      "desktop coordinator must independently validate source run, job, and artifact provenance",
    );
  }
  if (
    !bindRun.includes('CHILD_WORKFLOW_REF="$TAG"') ||
    !bindRun.includes('TOOLING_COMMIT="$COMMIT"') ||
    !bindRun.includes('if [ -n "$RECOVERY_TOOLING_TAG_INPUT" ]; then') ||
    !bindRun.includes("if [ \"$MODE\" != 'steady' ]; then") ||
    !bindRun.includes('RECOVERY_REVISION="${RECOVERY_TAG#"${TAG}-recovery."}"') ||
    !bindRun.includes("printf '%s' \"$RECOVERY_REVISION\" | grep -Eq '^[1-9][0-9]*$'") ||
    !bindRun.includes('[ "$RECOVERY_TAG" != "${TAG}-recovery.${RECOVERY_REVISION}" ]') ||
    !bindRun.includes('"refs/tags/$RECOVERY_TAG:refs/tags/$RECOVERY_TAG"') ||
    !bindRun.includes('TOOLING_COMMIT=$(git rev-parse "refs/tags/$RECOVERY_TAG^{commit}")') ||
    !bindRun.includes('test "$TOOLING_COMMIT" != "$COMMIT"') ||
    !bindRun.includes('test "$WORKFLOW_REF" = "refs/tags/$RECOVERY_TAG"') ||
    !bindRun.includes('test "$WORKFLOW_SHA" = "$TOOLING_COMMIT"') ||
    !bindRun.includes('git merge-base --is-ancestor "$COMMIT" "$TOOLING_COMMIT"') ||
    !bindRun.includes('git merge-base --is-ancestor "$TOOLING_COMMIT" refs/remotes/origin/main') ||
    !bindRun.includes('CHILD_WORKFLOW_REF="$RECOVERY_TAG"') ||
    !bindRun.includes('echo "workflow_ref=$CHILD_WORKFLOW_REF" >> "$GITHUB_OUTPUT"') ||
    !bindRun.includes('echo "tooling_commit=$TOOLING_COMMIT" >> "$GITHUB_OUTPUT"')
  ) {
    issues.push(
      "desktop recovery tooling must use a distinct immutable steady-only tag merged into main",
    );
  }

  const draftNeeds = scalar(draft.needs);
  const draftOutputs = mapping(draft.outputs, "desktop coordinator draft outputs", issues);
  const draftStep = namedStep(draft, "Create or validate bound desktop release draft");
  const draftEnvironment = mapping(draftStep?.env, "desktop release draft environment", issues);
  const draftRun = typeof draftStep?.run === "string" ? draftStep.run : "";
  const expectedDraftEnvironment: Mapping = {
    GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}",
    RELEASE_TAG: "${{ needs.bind-release.outputs.tag }}",
    RELEASE_VERSION: "${{ needs.bind-release.outputs.desktop_version }}",
    RELEASE_COMMIT: "${{ needs.bind-release.outputs.commit }}",
    RELEASE_SOURCE_RUN_ID: "${{ needs.bind-release.outputs.source_run_id }}",
  };
  const coordinatorPublicAdmission = [
    "  else",
    "    test \"$RELEASE_SOURCE_RUN_ID\" != 'none'",
    `    if [ "$(printf '%s' "$RELEASE_JSON" | jq -r '.body')" != '${PROVISIONAL_RELEASE_BODY}' ]; then`,
  ].join("\n");
  const coordinatorLatestLookup =
    "LATEST_JSON=$(gh api -H 'Cache-Control: no-cache' \"repos/$GITHUB_REPOSITORY/releases/latest\")";
  if (
    !draftNeeds.includes("bind-release") ||
    draftOutputs.draft_id !== "${{ steps.release-draft.outputs.draft_id }}" ||
    draftOutputs.body_sha256 !== "${{ steps.release-draft.outputs.body_sha256 }}" ||
    !exactKeys(draftEnvironment, Object.keys(expectedDraftEnvironment)) ||
    Object.entries(expectedDraftEnvironment).some(
      ([key, value]) => draftEnvironment[key] !== value,
    ) ||
    !draftRun.includes("apps/desktop/CHANGELOG.md") ||
    draftRun.includes("packages/cycling-coach/CHANGELOG.md") ||
    !draftRun.includes('test "$FIRST_HEADING" = "## $RELEASE_VERSION"') ||
    !draftRun.includes("--json body,databaseId,isDraft,isPrerelease,tagName") ||
    !draftRun.includes(".isPrerelease')\" = 'false'") ||
    !draftRun.includes(
      "if [ \"$(printf '%s' \"$RELEASE_JSON\" | jq -r '.isDraft')\" = 'true' ]; then",
    ) ||
    countShellLine(draftRun, 'test "$EXISTING_BODY_SHA256" = "$BODY_SHA256"') !== 2 ||
    !draftRun.includes(coordinatorPublicAdmission) ||
    countShellLine(draftRun, coordinatorLatestLookup) !== 1 ||
    !draftRun.includes(
      "test \"$(printf '%s' \"$LATEST_JSON\" | jq -r '.id | tostring')\" = \"$(printf '%s' \"$RELEASE_JSON\" | jq -r '.databaseId | tostring')\"",
    ) ||
    !draftRun.includes(
      'test "$(printf \'%s\' "$LATEST_JSON" | jq -r \'.tag_name\')" = "$RELEASE_TAG"',
    ) ||
    !draftRun.includes(
      'gh release create "$RELEASE_TAG" --draft --latest=false --target "$RELEASE_COMMIT"',
    )
  ) {
    issues.push(
      "desktop coordinator must admit only an exact draft, recovery-provisional public release, or live-latest exact-final release",
    );
  }
  if (!draftRun.includes("else\n  test \"$RELEASE_SOURCE_RUN_ID\" = 'none'\n  gh release create")) {
    issues.push("desktop coordinator recovery must never create a missing candidate release");
  }

  const dispatchNeeds = scalar(dispatch.needs);
  const dispatchBindingStep = namedStep(dispatch, "Seal exact child dispatch binding");
  const dispatchBindingEnvironment = mapping(
    dispatchBindingStep?.env,
    "desktop dispatch binding environment",
    issues,
  );
  const dispatchBindingRun =
    typeof dispatchBindingStep?.run === "string" ? dispatchBindingStep.run : "";
  const dispatchBindingUploads = actionSteps(dispatch, "actions/upload-artifact");
  const dispatchStep = namedStep(
    dispatch,
    "Dispatch and await environment-bound desktop transaction",
  );
  const dispatchEnvironment = mapping(
    dispatchStep?.env,
    "desktop coordinator dispatch environment",
    issues,
  );
  const dispatchRun = typeof dispatchStep?.run === "string" ? dispatchStep.run : "";
  const expectedDispatchEnvironment: Mapping = {
    RELEASE_TAG: "${{ needs.bind-release.outputs.tag }}",
    DESKTOP_VERSION: "${{ needs.bind-release.outputs.desktop_version }}",
    RELEASE_COMMIT: "${{ needs.bind-release.outputs.commit }}",
    RELEASE_WORKFLOW_REF: "${{ needs.bind-release.outputs.workflow_ref }}",
    RELEASE_TOOLING_COMMIT: "${{ needs.bind-release.outputs.tooling_commit }}",
    RELEASE_DRAFT_ID: "${{ needs.prepare-release-draft.outputs.draft_id }}",
    RELEASE_MODE: "${{ needs.bind-release.outputs.mode }}",
    RELEASE_BODY_SHA256: "${{ needs.prepare-release-draft.outputs.body_sha256 }}",
    RELEASE_BASELINE_TAG: "${{ needs.bind-release.outputs.baseline_tag }}",
    RELEASE_SOURCE_RUN_ID: "${{ needs.bind-release.outputs.source_run_id }}",
    COORDINATOR_RUN_ID: "${{ github.run_id }}",
    COORDINATOR_RUN_ATTEMPT: "${{ github.run_attempt }}",
    DISPATCH_NONCE: "${{ steps.dispatch-binding.outputs.nonce }}",
    DISPATCH_BINDING_SHA256: "${{ steps.dispatch-binding.outputs.sha256 }}",
  };
  const dispatchedInputs = Array.from(
    dispatchRun.matchAll(/(?:^|\s)-f ([a-z0-9_]+)=/gu),
    (match) => match[1],
  );
  const expectedDispatchedInputs = [
    "tag",
    "desktop_version",
    "commit",
    "tooling_commit",
    "draft_id",
    "mode",
    "draft_body_sha256",
    "baseline_tag",
    "source_run_id",
    "coordinator_run_id",
    "coordinator_run_attempt",
    "dispatch_nonce",
    "dispatch_binding_sha256",
  ];
  const expectedDispatchedAssignments: Mapping = {
    tag: "RELEASE_TAG",
    desktop_version: "DESKTOP_VERSION",
    commit: "RELEASE_COMMIT",
    tooling_commit: "RELEASE_TOOLING_COMMIT",
    draft_id: "RELEASE_DRAFT_ID",
    mode: "RELEASE_MODE",
    draft_body_sha256: "RELEASE_BODY_SHA256",
    baseline_tag: "RELEASE_BASELINE_TAG",
    source_run_id: "RELEASE_SOURCE_RUN_ID",
    coordinator_run_id: "COORDINATOR_RUN_ID",
    coordinator_run_attempt: "COORDINATOR_RUN_ATTEMPT",
    dispatch_nonce: "DISPATCH_NONCE",
    dispatch_binding_sha256: "DISPATCH_BINDING_SHA256",
  };
  const expectedBindingObject =
    "{schemaVersion: 1, repository: $repository, repositoryId: $repositoryId, coordinatorRunId: $coordinatorRunId, coordinatorRunAttempt: $coordinatorRunAttempt, workflowRef: $workflowRef, workflowSha: $workflowSha, childWorkflowRef: $childWorkflowRef, tag: $tag, desktopVersion: $desktopVersion, commit: $commit, toolingCommit: $toolingCommit, draftId: $draftId, mode: $mode, draftBodySha256: $draftBodySha256, baselineTag: $baselineTag, sourceRunId: $sourceRunId, nonce: $nonce}";
  const expectedBindingEnvironment: Mapping = {
    RELEASE_TAG: "${{ needs.bind-release.outputs.tag }}",
    DESKTOP_VERSION: "${{ needs.bind-release.outputs.desktop_version }}",
    RELEASE_COMMIT: "${{ needs.bind-release.outputs.commit }}",
    RELEASE_WORKFLOW_REF: "${{ needs.bind-release.outputs.workflow_ref }}",
    RELEASE_TOOLING_COMMIT: "${{ needs.bind-release.outputs.tooling_commit }}",
    RELEASE_DRAFT_ID: "${{ needs.prepare-release-draft.outputs.draft_id }}",
    RELEASE_MODE: "${{ needs.bind-release.outputs.mode }}",
    RELEASE_BODY_SHA256: "${{ needs.prepare-release-draft.outputs.body_sha256 }}",
    RELEASE_BASELINE_TAG: "${{ needs.bind-release.outputs.baseline_tag }}",
    RELEASE_SOURCE_RUN_ID: "${{ needs.bind-release.outputs.source_run_id }}",
    COORDINATOR_RUN_ID: "${{ github.run_id }}",
    COORDINATOR_RUN_ATTEMPT: "${{ github.run_attempt }}",
    REPOSITORY: "${{ github.repository }}",
    REPOSITORY_ID: "${{ github.repository_id }}",
    WORKFLOW_REF: "${{ github.ref }}",
    WORKFLOW_SHA: "${{ github.sha }}",
  };
  const bindingUploadInputs = mapping(
    dispatchBindingUploads[0]?.with,
    "desktop dispatch binding upload inputs",
    issues,
  );
  if (
    dispatchBindingStep?.id !== "dispatch-binding" ||
    !exactKeys(dispatchBindingEnvironment, Object.keys(expectedBindingEnvironment)) ||
    Object.entries(expectedBindingEnvironment).some(
      ([key, value]) => dispatchBindingEnvironment[key] !== value,
    ) ||
    !dispatchBindingRun.includes("DISPATCH_NONCE=$(openssl rand -hex 32)") ||
    !dispatchBindingRun.includes("printf '%s' \"$DISPATCH_NONCE\" | grep -Eq '^[0-9a-f]{64}$'") ||
    !dispatchBindingRun.includes(expectedBindingObject) ||
    !dispatchBindingRun.includes(
      "BINDING_SHA256=$(printf '%s' \"$BINDING\" | sha256sum | awk '{print $1}')",
    ) ||
    !dispatchBindingRun.includes(
      'ARTIFACT_NAME="desktop-dispatch-binding-$COORDINATOR_RUN_ID-$COORDINATOR_RUN_ATTEMPT-$BINDING_SHA256"',
    ) ||
    !dispatchBindingRun.includes(
      'printf \'%s\' "$BINDING" > "$RUNNER_TEMP/desktop-dispatch-binding.json"',
    ) ||
    dispatchBindingUploads.length !== 1 ||
    !exactKeys(bindingUploadInputs, [
      "name",
      "path",
      "if-no-files-found",
      "compression-level",
      "retention-days",
    ]) ||
    bindingUploadInputs.name !== "${{ steps.dispatch-binding.outputs.artifact_name }}" ||
    bindingUploadInputs.path !== "${{ runner.temp }}/desktop-dispatch-binding.json" ||
    bindingUploadInputs["if-no-files-found"] !== "error" ||
    bindingUploadInputs["compression-level"] !== 0 ||
    bindingUploadInputs["retention-days"] !== 1
  ) {
    issues.push("desktop coordinator must seal exactly one nonce-bound full dispatch tuple");
  }
  if (
    !dispatchNeeds.includes("bind-release") ||
    !dispatchNeeds.includes("prepare-release-draft") ||
    Object.entries(expectedDispatchEnvironment).some(
      ([key, value]) => dispatchEnvironment[key] !== value,
    ) ||
    !exactKeys(
      Object.fromEntries(dispatchedInputs.map((input) => [input, true])),
      expectedDispatchedInputs,
    ) ||
    dispatchedInputs.length !== expectedDispatchedInputs.length ||
    Object.entries(expectedDispatchedAssignments).some(
      ([input, variable]) => !dispatchRun.includes(`-f ${input}="$${variable}"`),
    ) ||
    !dispatchRun.includes("gh workflow run desktop-release.yml \\") ||
    !dispatchRun.includes('--ref "$RELEASE_WORKFLOW_REF"') ||
    (dispatchRun.match(/--repo "\$GITHUB_REPOSITORY"/gu) ?? []).length !== 3 ||
    !dispatchRun.includes('--arg title "$EXPECTED_TITLE"') ||
    !dispatchRun.includes(
      'EXPECTED_TITLE="Desktop release $RELEASE_TAG via $COORDINATOR_RUN_ID.$COORDINATOR_RUN_ATTEMPT binding $DISPATCH_BINDING_SHA256"',
    ) ||
    !dispatchRun.includes(
      'gh run watch "$DESKTOP_RUN_ID" --repo "$GITHUB_REPOSITORY" --interval 15 --exit-status',
    ) ||
    /npm_version|npm_integrity|npm_attestation_url/u.test(dispatchRun)
  ) {
    issues.push("desktop coordinator must dispatch and await one npm-independent child tuple");
  }
}

function checkNpmRelease(source: string, release: Mapping, issues: string[]): void {
  const workflowOn = mapping(release.on, "npm release.on", issues);
  if (!("push" in workflowOn) || !("workflow_dispatch" in workflowOn)) {
    issues.push("release.yml must remain the npm tag/manual coordinator");
  }
  const push = mapping(workflowOn.push, "npm release push trigger", issues);
  const tags = Array.isArray(push.tags) ? push.tags.map(String) : [];
  const dispatch = mapping(workflowOn.workflow_dispatch, "npm release workflow_dispatch", issues);
  const dispatchInputs = mapping(dispatch.inputs, "npm release workflow_dispatch inputs", issues);
  if (
    tags.length === 0 ||
    tags.some((tag) => tag.startsWith("enduragent-desktop@")) ||
    !exactKeys(dispatchInputs, ["package", "tag"])
  ) {
    issues.push("npm release triggers must not authorize desktop candidates");
  }
  exactPermissions(release.permissions, { contents: "read" }, "npm release", issues);
  requireQueue(release.concurrency, "npm-release-coordinator", "npm release", issues);

  const jobs = mapping(release.jobs, "npm release.jobs", issues);
  for (const legacyJobName of ["prepare-release-draft", "desktop-release"]) {
    if (
      legacyJobName in jobs &&
      mapping(jobs[legacyJobName], `npm release.jobs.${legacyJobName}`, issues).if !==
        "${{ false }}"
    ) {
      issues.push("legacy npm-side desktop jobs must remain literally disabled");
    }
  }
  const liveJobsText = Object.entries(jobs)
    .filter(([, rawJob]) => mapping(rawJob, "npm release live job", issues).if !== "${{ false }}")
    .map(([, rawJob]) => scalar(rawJob))
    .join("\n");
  const parseTag = mapping(jobs["parse-tag"], "npm release.jobs.parse-tag", issues);
  const parseOutputs = mapping(parseTag.outputs, "npm parse-tag outputs", issues);
  if (
    Object.keys(parseOutputs).some((key) => key.startsWith("desktop")) ||
    /apps\/desktop|ENABLE_DESKTOP_MACOS_RELEASE|enduragent-desktop@|desktop-release\.yml/u.test(
      liveJobsText,
    )
  ) {
    issues.push("npm release workflow must have no live desktop parse or dispatch authority");
  }

  const smoke = mapping(jobs.smoke, "npm release.jobs.smoke", issues);
  const npmPublish = mapping(jobs["publish-npm"], "npm release.jobs.publish-npm", issues);
  const npmVerify = mapping(
    jobs["verify-npm-publication"],
    "npm release.jobs.verify-npm-publication",
    issues,
  );
  const packageRelease = mapping(
    jobs["publish-package-only-release"],
    "npm release.jobs.publish-package-only-release",
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
  exactPermissions(packageRelease.permissions, { contents: "write" }, "npm GitHub release", issues);
  if (npmPublish.environment !== "npm-production") {
    issues.push("npm publication must use the protected npm-production environment");
  }
  if (!scalar(npmVerify.needs).includes("publish-npm") || "environment" in npmVerify) {
    issues.push("no-OIDC npm verification must follow publication outside a protected environment");
  }

  const smokeOutputs = mapping(smoke.outputs, "npm smoke outputs", issues);
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
    if (!(output in smokeOutputs)) {
      issues.push(`immutable npm preparation is missing ${output}`);
    }
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
    if (!(output in npmPublishOutputs)) {
      issues.push(`npm publication tuple is missing ${output}`);
    }
  }
  const npmVerifyOutputs = mapping(npmVerify.outputs, "npm verification outputs", issues);
  if (
    npmVerifyOutputs.npm_integrity !== "${{ steps.verify.outputs.npm_integrity }}" ||
    npmVerifyOutputs.npm_attestation_url !== "${{ steps.verify.outputs.npm_attestation_url }}"
  ) {
    issues.push("verified npm integrity and attestation URL must remain exposed as job outputs");
  }

  const publishText = runs(npmPublish).join("\n");
  const verifyText = runs(npmVerify).join("\n");
  const smokeText = runs(smoke).join("\n");
  if (
    steps(npmPublish).some(
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
    !source.includes("actions/upload-artifact@") ||
    (source.match(/actions\/download-artifact@[^\n]+# v8/gu) ?? []).length < 2 ||
    (source.match(/artifact-ids:/gu) ?? []).length < 2 ||
    (source.match(/digest-mismatch: error/gu) ?? []).length < 2
  ) {
    issues.push("npm prepare, publish, and verify must reuse one digest-checked Actions artifact");
  }
  if (
    (publishText.match(/npm publish/gu) ?? []).length !== 2 ||
    (publishText.match(/--registry=https:\/\/registry\.npmjs\.org\//gu) ?? []).length < 4 ||
    (publishText.match(/--provenance/gu) ?? []).length !== 2 ||
    (publishText.match(/--ignore-scripts/gu) ?? []).length !== 2
  ) {
    issues.push("both npm identities must publish exact tarballs through the public registry");
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
    source.includes(".gitHead")
  ) {
    issues.push("no-OIDC verification must bind public bytes, signatures, and exact provenance");
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
  ) {
    issues.push("npm attestation URL must be canonicalized before network fetch");
  }

  const packageReleaseText = runs(packageRelease).join("\n");
  if (
    !scalar(packageRelease.needs).includes("verify-npm-publication") ||
    !packageReleaseText.includes('gh release view "$TAG"') ||
    !packageReleaseText.includes("Leaving it untouched") ||
    !packageReleaseText.includes('gh release create "$TAG" --latest=false') ||
    packageReleaseText.includes("--draft")
  ) {
    issues.push(
      "npm GitHub releases must be verified, non-latest, and never replace existing releases",
    );
  }
}

function checkDesktopChild(source: string, desktop: Mapping, issues: string[]): void {
  const workflowOn = mapping(desktop.on, "desktop child.on", issues);
  if (Object.keys(workflowOn).length !== 1 || !("workflow_dispatch" in workflowOn)) {
    issues.push("desktop-release.yml must be workflow_dispatch-only");
  }
  const workflowDispatch = mapping(workflowOn.workflow_dispatch, "desktop child dispatch", issues);
  const inputs = mapping(workflowDispatch.inputs, "desktop child inputs", issues);
  const expectedInputs = [
    "tag",
    "desktop_version",
    "commit",
    "tooling_commit",
    "draft_id",
    "mode",
    "draft_body_sha256",
    "baseline_tag",
    "source_run_id",
    "coordinator_run_id",
    "coordinator_run_attempt",
    "dispatch_nonce",
    "dispatch_binding_sha256",
  ];
  if (!exactKeys(inputs, expectedInputs)) {
    issues.push("desktop child must accept only the frozen desktop release tuple");
  }
  for (const input of expectedInputs) {
    const declaration = mapping(inputs[input], `desktop child input ${input}`, issues);
    if (declaration.required !== true || declaration.type !== "string") {
      issues.push(`desktop workflow_dispatch must require string input ${input}`);
    }
  }
  if (
    /\bnpm_(?:version|integrity|attestation_url)\b|--npm-(?:version|integrity|attestation-url)\b/u.test(
      source,
    )
  ) {
    issues.push("desktop child must not consume npm release identity or provenance");
  }
  if (
    desktop["run-name"] !==
    "Desktop release ${{ inputs.tag }} via ${{ inputs.coordinator_run_id }}.${{ inputs.coordinator_run_attempt }} binding ${{ inputs.dispatch_binding_sha256 }}"
  ) {
    issues.push("desktop child run name must bind its coordinator invocation");
  }
  exactPermissions(
    desktop.permissions,
    { actions: "read", contents: "read" },
    "desktop child",
    issues,
  );
  requireQueue(desktop.concurrency, "stable-desktop", "desktop release", issues);

  const requiredSigningSecrets = [
    "CSC_LINK",
    "CSC_KEY_PASSWORD",
    "APPLE_API_KEY_ID",
    "APPLE_API_ISSUER",
    "APPLE_API_KEY_P8_BASE64",
  ];
  const jobs = mapping(desktop.jobs, "desktop.jobs", issues);
  const authorize = mapping(
    jobs["authorize-coordinator"],
    "desktop.jobs.authorize-coordinator",
    issues,
  );
  const sign = mapping(jobs["sign-macos"], "desktop.jobs.sign-macos", issues);
  const verify = mapping(
    jobs["verify-macos-envelope"],
    "desktop.jobs.verify-macos-envelope",
    issues,
  );
  const stage = mapping(jobs["stage-private-draft"], "desktop.jobs.stage-private-draft", issues);
  const publish = mapping(jobs["publish-assets"], "desktop.jobs.publish-assets", issues);
  const requestLatest = mapping(jobs["request-latest"], "desktop.jobs.request-latest", issues);
  const reconcileLatest = mapping(
    jobs["reconcile-latest"],
    "desktop.jobs.reconcile-latest",
    issues,
  );
  const roundTrip = mapping(
    jobs["verify-production-update"],
    "desktop.jobs.verify-production-update",
    issues,
  );
  const activate = mapping(jobs["activate-release"], "desktop.jobs.activate-release", issues);
  const compensate = mapping(
    jobs["compensate-publication"],
    "desktop.jobs.compensate-publication",
    issues,
  );

  exactPermissions(
    authorize.permissions,
    { actions: "read", contents: "read" },
    "desktop coordinator authorization",
    issues,
  );
  const authorizeStep = namedStep(authorize, "Bind dispatch to the active release coordinator");
  const authorizeEnvironment = mapping(
    authorizeStep?.env,
    "desktop coordinator authorization environment",
    issues,
  );
  const authorizeRun = typeof authorizeStep?.run === "string" ? authorizeStep.run : "";
  const authorizeOutputs = mapping(authorize.outputs, "desktop authorization outputs", issues);
  const expectedAuthorizeOutputs: Mapping = {
    source_run_id: "${{ steps.authorize.outputs.source_run_id }}",
    source_run_attempt: "${{ steps.authorize.outputs.source_run_attempt }}",
    artifact_name: "${{ steps.authorize.outputs.artifact_name }}",
    artifact_id: "${{ steps.authorize.outputs.artifact_id }}",
    artifact_digest: "${{ steps.authorize.outputs.artifact_digest }}",
    baseline_artifact_name: "${{ steps.authorize.outputs.baseline_artifact_name }}",
    baseline_artifact_id: "${{ steps.authorize.outputs.baseline_artifact_id }}",
    baseline_artifact_digest: "${{ steps.authorize.outputs.baseline_artifact_digest }}",
  };
  if (
    sign.needs !== "authorize-coordinator" ||
    authorizeEnvironment.RELEASE_TAG !== "${{ inputs.tag }}" ||
    authorizeEnvironment.DESKTOP_VERSION !== "${{ inputs.desktop_version }}" ||
    authorizeEnvironment.RELEASE_DRAFT_ID !== "${{ inputs.draft_id }}" ||
    authorizeEnvironment.RELEASE_BODY_SHA256 !== "${{ inputs.draft_body_sha256 }}" ||
    authorizeEnvironment.RELEASE_BASELINE_TAG !== "${{ inputs.baseline_tag }}" ||
    authorizeEnvironment.RELEASE_MODE !== "${{ inputs.mode }}" ||
    authorizeEnvironment.SOURCE_RUN_ID !== "${{ inputs.source_run_id }}" ||
    authorizeEnvironment.DISPATCH_NONCE !== "${{ inputs.dispatch_nonce }}" ||
    authorizeEnvironment.DISPATCH_BINDING_SHA256 !== "${{ inputs.dispatch_binding_sha256 }}" ||
    authorizeEnvironment.RUN_ACTOR !== "${{ github.actor }}" ||
    authorizeEnvironment.RUN_TRIGGERING_ACTOR !== "${{ github.triggering_actor }}" ||
    authorizeEnvironment.REPOSITORY_ID !== "${{ github.repository_id }}" ||
    authorizeEnvironment.WORKFLOW_REF !== "${{ github.ref }}" ||
    authorizeEnvironment.WORKFLOW_REF_NAME !== "${{ github.ref_name }}" ||
    !authorizeRun.includes('gh api "repos/$GITHUB_REPOSITORY/actions/runs/$COORDINATOR_RUN_ID"') ||
    !authorizeRun.includes(".github/workflows/desktop-release-coordinator.yml") ||
    authorizeRun.includes(".github/workflows/release.yml") ||
    !authorizeRun.includes(
      'test "$(printf \'%s\' "$COORDINATOR" | jq -r \'.run_attempt\')" = "$COORDINATOR_RUN_ATTEMPT"',
    ) ||
    !authorizeRun.includes(".status") ||
    !authorizeRun.includes("in_progress") ||
    !authorizeRun.includes(".head_sha") ||
    !authorizeRun.includes('test "$RELEASE_TOOLING_COMMIT" = "$WORKFLOW_COMMIT"') ||
    !authorizeRun.includes(".head_branch") ||
    !authorizeRun.includes(
      'test "$(printf \'%s\' "$COORDINATOR" | jq -r \'.head_branch\')" = "$WORKFLOW_REF_NAME"',
    ) ||
    !authorizeRun.includes('if [ "$RELEASE_TOOLING_COMMIT" = "$RELEASE_COMMIT" ]; then') ||
    !authorizeRun.includes('test "$WORKFLOW_REF" = "refs/tags/$RELEASE_TAG"') ||
    !authorizeRun.includes('test "$WORKFLOW_REF_NAME" = "$RELEASE_TAG"') ||
    !authorizeRun.includes("test \"$RELEASE_MODE\" = 'steady'") ||
    !authorizeRun.includes(
      'CURRENT_RECOVERY_REVISION="${WORKFLOW_REF_NAME#"${RELEASE_TAG}-recovery."}"',
    ) ||
    !authorizeRun.includes("grep -Eq '^[1-9][0-9]*$'") ||
    !authorizeRun.includes(
      'test "$WORKFLOW_REF_NAME" = "${RELEASE_TAG}-recovery.${CURRENT_RECOVERY_REVISION}"',
    ) ||
    !authorizeRun.includes('test "$WORKFLOW_REF" = "refs/tags/$WORKFLOW_REF_NAME"') ||
    !authorizeRun.includes("workflow_dispatch") ||
    authorizeRun.includes('.event == "push"') ||
    !exactKeys(authorizeOutputs, Object.keys(expectedAuthorizeOutputs)) ||
    Object.entries(expectedAuthorizeOutputs).some(([key, value]) => authorizeOutputs[key] !== value)
  ) {
    issues.push("desktop signing must authorize only its active desktop coordinator");
  }
  const expectedChildBindingObject =
    "{schemaVersion: 1, repository: $repository, repositoryId: $repositoryId, coordinatorRunId: $coordinatorRunId, coordinatorRunAttempt: $coordinatorRunAttempt, workflowRef: $workflowRef, workflowSha: $workflowSha, childWorkflowRef: $childWorkflowRef, tag: $tag, desktopVersion: $desktopVersion, commit: $commit, toolingCommit: $toolingCommit, draftId: $draftId, mode: $mode, draftBodySha256: $draftBodySha256, baselineTag: $baselineTag, sourceRunId: $sourceRunId, nonce: $nonce}";
  const sourceValidationStart = authorizeRun.indexOf(
    'SOURCE=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$SOURCE_RUN_ID")',
  );
  const bindingValidationRun = authorizeRun.slice(
    authorizeRun.indexOf("BINDING_ARTIFACT_NAME="),
    sourceValidationStart,
  );
  if (
    !authorizeRun.includes("test \"$RUN_ACTOR\" = 'github-actions[bot]'") ||
    !authorizeRun.includes("test \"$RUN_TRIGGERING_ACTOR\" = 'github-actions[bot]'") ||
    !authorizeRun.includes("printf '%s' \"$DISPATCH_NONCE\" | grep -Eq '^[0-9a-f]{64}$'") ||
    !authorizeRun.includes(
      "printf '%s' \"$DISPATCH_BINDING_SHA256\" | grep -Eq '^[0-9a-f]{64}$'",
    ) ||
    !authorizeRun.includes(expectedChildBindingObject) ||
    !authorizeRun.includes(
      'test "$(printf \'%s\' "$BINDING" | sha256sum | awk \'{print $1}\')" = "$DISPATCH_BINDING_SHA256"',
    ) ||
    !authorizeRun.includes(
      'BINDING_ARTIFACT_NAME="desktop-dispatch-binding-$COORDINATOR_RUN_ID-$COORDINATOR_RUN_ATTEMPT-$DISPATCH_BINDING_SHA256"',
    ) ||
    !bindingValidationRun.includes("actions/runs/$COORDINATOR_RUN_ID/artifacts?per_page=100") ||
    !bindingValidationRun.includes("([.[].artifacts[]] | length) == .[0].total_count") ||
    !bindingValidationRun.includes(
      "'[.[].artifacts[] | select(.name == $name)] | select(length == 1) | .[0]'",
    ) ||
    !bindingValidationRun.includes(".size_in_bytes") ||
    !bindingValidationRun.includes(".workflow_run.repository_id") ||
    !bindingValidationRun.includes(".workflow_run.head_repository_id") ||
    !bindingValidationRun.includes(".workflow_run.head_branch") ||
    !bindingValidationRun.includes(".workflow_run.head_sha")
  ) {
    issues.push(
      "desktop child must require bot actors and one coordinator-owned nonce-bound dispatch artifact",
    );
  }
  const sourceValidationRun = authorizeRun.slice(sourceValidationStart);
  if (
    !authorizeRun.includes("if [ \"$SOURCE_RUN_ID\" = 'none' ]; then") ||
    !authorizeRun.includes(
      "for output in source_run_id source_run_attempt artifact_name artifact_id artifact_digest baseline_artifact_name baseline_artifact_id baseline_artifact_digest; do",
    ) ||
    !authorizeRun.includes('test "$SOURCE_RUN_ID" != "$GITHUB_RUN_ID"') ||
    !authorizeRun.includes('test "$SOURCE_RUN_ID" != "$COORDINATOR_RUN_ID"') ||
    !authorizeRun.includes("test \"$RELEASE_MODE\" = 'steady'") ||
    !authorizeRun.includes('test "$RELEASE_TOOLING_COMMIT" != "$RELEASE_COMMIT"') ||
    !authorizeRun.includes("test \"$CURRENT_RECOVERY_REVISION\" != 'none'") ||
    !authorizeRun.includes(
      'SOURCE=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$SOURCE_RUN_ID")',
    ) ||
    !authorizeRun.includes(".repository.full_name") ||
    !authorizeRun.includes(".head_repository.full_name") ||
    !authorizeRun.includes(".github/workflows/desktop-release.yml") ||
    !authorizeRun.includes(".event')\" = 'workflow_dispatch'") ||
    !authorizeRun.includes(".actor.login')\" = 'github-actions[bot]'") ||
    !authorizeRun.includes(".triggering_actor.login')\" = 'github-actions[bot]'") ||
    !authorizeRun.includes(".status')\" = 'completed'") ||
    !authorizeRun.includes(".conclusion')\" = 'failure'") ||
    !authorizeRun.includes("SOURCE_RUN_ATTEMPT=") ||
    !authorizeRun.includes(
      'SOURCE_RECOVERY_REVISION="${SOURCE_HEAD_BRANCH#"${RELEASE_TAG}-recovery."}"',
    ) ||
    !authorizeRun.includes(
      'test "$SOURCE_HEAD_BRANCH" = "${RELEASE_TAG}-recovery.${SOURCE_RECOVERY_REVISION}"',
    ) ||
    !authorizeRun.includes('test "$SOURCE_RECOVERY_REVISION" != "$CURRENT_RECOVERY_REVISION"') ||
    !authorizeRun.includes("sort -n | head -1") ||
    !authorizeRun.includes(
      'test "$(git rev-parse "refs/tags/$SOURCE_HEAD_BRANCH^{commit}")" = "$SOURCE_HEAD_SHA"',
    ) ||
    !authorizeRun.includes('git merge-base --is-ancestor "$RELEASE_COMMIT" "$SOURCE_HEAD_SHA"') ||
    !authorizeRun.includes(
      'git merge-base --is-ancestor "$SOURCE_HEAD_SHA" "$RELEASE_TOOLING_COMMIT"',
    ) ||
    !authorizeRun.includes(
      'git merge-base --is-ancestor "$SOURCE_HEAD_SHA" refs/remotes/origin/main',
    ) ||
    !authorizeRun.includes("gh api --paginate --slurp") ||
    !authorizeRun.includes(
      "actions/runs/$SOURCE_RUN_ID/attempts/$SOURCE_RUN_ATTEMPT/jobs?per_page=100",
    ) ||
    !authorizeRun.includes("([.[].jobs[]] | length) == .[0].total_count") ||
    !authorizeRun.includes(
      "for job_name in sign-macos verify-macos-envelope stage-private-draft publish-assets; do",
    ) ||
    !authorizeRun.includes('$matches[0].conclusion == "success"') ||
    !authorizeRun.includes('$matches[0].conclusion != "success"') ||
    !authorizeRun.includes("actions/runs/$SOURCE_RUN_ID/artifacts?per_page=100") ||
    !authorizeRun.includes("([.[].artifacts[]] | length) == .[0].total_count") ||
    !authorizeRun.includes('ARTIFACT_NAME="desktop-release-$SOURCE_RUN_ID-$SOURCE_RUN_ATTEMPT"') ||
    !authorizeRun.includes(
      'BASELINE_ARTIFACT_NAME="desktop-baseline-$SOURCE_RUN_ID-$SOURCE_RUN_ATTEMPT"',
    ) ||
    (sourceValidationRun.match(/select\(length == 1\)/gu) ?? []).length !== 2 ||
    !authorizeRun.includes(".size_in_bytes") ||
    !authorizeRun.includes(".workflow_run.repository_id") ||
    !authorizeRun.includes(".workflow_run.head_repository_id") ||
    !authorizeRun.includes(".workflow_run.head_branch") ||
    !authorizeRun.includes(".workflow_run.head_sha") ||
    (authorizeRun.match(/sub\("\^sha256:"; ""\)/gu) ?? []).length !== 2 ||
    !authorizeRun.includes('echo "artifact_digest=$ARTIFACT_DIGEST" >> "$GITHUB_OUTPUT"') ||
    !authorizeRun.includes(
      'echo "baseline_artifact_digest=$BASELINE_ARTIFACT_DIGEST" >> "$GITHUB_OUTPUT"',
    )
  ) {
    issues.push(
      "desktop child must independently validate source run, job, and artifact provenance",
    );
  }
  const candidateAdmissionStart = authorizeRun.indexOf(
    'CANDIDATE_RELEASE=$(gh api "repos/$GITHUB_REPOSITORY/releases/$RELEASE_DRAFT_ID")',
  );
  const noSourceExitStart = authorizeRun.indexOf("if [ \"$SOURCE_RUN_ID\" = 'none' ]; then");
  const candidateAdmissionRun =
    candidateAdmissionStart >= 0 && noSourceExitStart > candidateAdmissionStart
      ? authorizeRun.slice(candidateAdmissionStart, noSourceExitStart)
      : "";
  const childLatestLookup =
    "LATEST_RELEASE=$(gh api -H 'Cache-Control: no-cache' \"repos/$GITHUB_REPOSITORY/releases/latest\")";
  if (
    authorizeEnvironment.GH_TOKEN !== "${{ github.token }}" ||
    candidateAdmissionRun === "" ||
    !candidateAdmissionRun.includes(
      'test "$(printf \'%s\' "$CANDIDATE_RELEASE" | jq -r \'.id | tostring\')" = "$RELEASE_DRAFT_ID"',
    ) ||
    !candidateAdmissionRun.includes(
      'test "$(printf \'%s\' "$CANDIDATE_RELEASE" | jq -r \'.tag_name\')" = "$RELEASE_TAG"',
    ) ||
    !candidateAdmissionRun.includes(
      "test \"$(printf '%s' \"$CANDIDATE_RELEASE\" | jq -r '.prerelease')\" = 'false'",
    ) ||
    !candidateAdmissionRun.includes(
      "if [ \"$(printf '%s' \"$CANDIDATE_RELEASE\" | jq -r '.draft')\" = 'false' ]; then\n  test \"$SOURCE_RUN_ID\" != 'none'",
    ) ||
    !candidateAdmissionRun.includes(
      `if [ "$(printf '%s' "$CANDIDATE_RELEASE" | jq -r '.body')" != '${PROVISIONAL_RELEASE_BODY}' ]; then`,
    ) ||
    !candidateAdmissionRun.includes(
      "CANDIDATE_BODY_SHA256=$(printf '%s' \"$CANDIDATE_RELEASE\" | jq -j '.body' | shasum -a 256 | awk '{print $1}')",
    ) ||
    !candidateAdmissionRun.includes('test "$CANDIDATE_BODY_SHA256" = "$RELEASE_BODY_SHA256"') ||
    countShellLine(candidateAdmissionRun, childLatestLookup) !== 1 ||
    !candidateAdmissionRun.includes(
      'test "$(printf \'%s\' "$LATEST_RELEASE" | jq -r \'.id | tostring\')" = "$RELEASE_DRAFT_ID"',
    ) ||
    !candidateAdmissionRun.includes(
      'test "$(printf \'%s\' "$LATEST_RELEASE" | jq -r \'.tag_name\')" = "$RELEASE_TAG"',
    )
  ) {
    issues.push(
      "desktop child must independently admit public recovery only as provisional or live-latest exact-final",
    );
  }

  exactPermissions(
    sign.permissions,
    { actions: "read", contents: "read" },
    "macOS signing",
    issues,
  );
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
    requestLatest.permissions,
    { actions: "read", contents: "write" },
    "latest request",
    issues,
  );
  exactPermissions(
    reconcileLatest.permissions,
    { actions: "read", contents: "read" },
    "latest reconciliation",
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
  const nonSigningText = Object.entries(jobs)
    .filter(([jobName]) => jobName !== "sign-macos")
    .map(([jobName, rawJob]) => scalar(mapping(rawJob, `desktop.jobs.${jobName}`, issues)))
    .join("\n");
  for (const secret of signingSecrets) {
    if (new RegExp(`\\b${secret}\\b`, "u").test(nonSigningText)) {
      issues.push(`signing secret ${secret} escaped the signing job`);
    }
  }
  if (sign.environment !== "desktop-macos-signing") {
    issues.push("signing secrets must come from desktop-macos-signing environment");
  }
  if (
    Object.entries(jobs).some(
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
    requestLatest.environment !== "desktop-macos-latest" ||
    reconcileLatest.environment !== "desktop-macos-latest" ||
    activate.environment !== "desktop-macos-latest" ||
    compensate.environment !== "desktop-macos-latest"
  ) {
    issues.push("write-authority desktop jobs must use protected environments");
  }
  if (!scalar(stage.needs).includes("verify-macos-envelope") || verify.needs !== "sign-macos") {
    issues.push("independent macOS verification must follow signing before private staging");
  }

  const stageRun = runs(stage).join("\n");
  const publishRun = runs(publish).join("\n");
  const requestLatestRun = runs(requestLatest).join("\n");
  const reconcileLatestRun = runs(reconcileLatest).join("\n");
  const roundTripRun = runs(roundTrip).join("\n");
  const activateRun = runs(activate).join("\n");
  const compensateRun = runs(compensate).join("\n");
  const publishOutputs = mapping(publish.outputs, "desktop publish outputs", issues);
  const expectedPublishOutputs: Mapping = {
    latest_id: "${{ steps.observe.outputs.latest_id }}",
    latest_tag: "${{ steps.observe.outputs.latest_tag }}",
    latest_metadata_sha256: "${{ steps.observe.outputs.latest_metadata_sha256 }}",
    rollback_latest_id: "${{ steps.observe.outputs.rollback_latest_id }}",
    rollback_latest_tag: "${{ steps.observe.outputs.rollback_latest_tag }}",
    rollback_latest_metadata_sha256: "${{ steps.observe.outputs.rollback_latest_metadata_sha256 }}",
  };
  const observeStep = namedStep(publish, "Bind latest before public mutation");
  const observeEnvironment = mapping(observeStep?.env, "latest observation environment", issues);
  const observeIndex = publishRun.indexOf("desktop-release:transaction observe");
  const publicationIndex = publishRun.indexOf("desktop-release:transaction publish");
  if (
    !stageRun.includes("desktop-release:transaction stage") ||
    !exactStringSet(stage.needs, ["sign-macos", "verify-macos-envelope"]) ||
    !exactStringSet(publish.needs, ["sign-macos", "stage-private-draft"]) ||
    observeIndex === -1 ||
    publicationIndex <= observeIndex ||
    !publishRun.includes('--expected-latest-id "$EXPECTED_LATEST_ID"') ||
    !publishRun.includes('--expected-latest-tag "$EXPECTED_LATEST_TAG"') ||
    !publishRun.includes('--expected-latest-metadata-sha256 "$EXPECTED_LATEST_METADATA_SHA256"') ||
    observeEnvironment.BASELINE_METADATA_SHA256 !==
      "${{ needs.sign-macos.outputs.baseline_metadata_sha256 }}" ||
    !publishRun.includes('--baseline-metadata-sha256 "$BASELINE_METADATA_SHA256"') ||
    !exactKeys(publishOutputs, Object.keys(expectedPublishOutputs)) ||
    Object.entries(expectedPublishOutputs).some(([key, value]) => publishOutputs[key] !== value)
  ) {
    issues.push("desktop publication must stage exact assets and bind latest before metadata-last");
  }
  if (
    observeEnvironment.BASELINE_METADATA_SHA256 !==
      "${{ needs.sign-macos.outputs.baseline_metadata_sha256 }}" ||
    !publishRun.includes('--baseline-metadata-sha256 "$BASELINE_METADATA_SHA256"') ||
    publishOutputs.rollback_latest_id !== "${{ steps.observe.outputs.rollback_latest_id }}" ||
    publishOutputs.rollback_latest_tag !== "${{ steps.observe.outputs.rollback_latest_tag }}" ||
    publishOutputs.rollback_latest_metadata_sha256 !==
      "${{ steps.observe.outputs.rollback_latest_metadata_sha256 }}"
  ) {
    issues.push("desktop rollback must remain bound to normalized manifest baseline evidence");
  }
  if (
    mapping(requestLatest.permissions, "latest request permissions", issues).contents !== "write" ||
    !exactStringSet(requestLatest.needs, ["sign-macos", "publish-assets"]) ||
    !requestLatestRun.includes("desktop-release:transaction promote") ||
    !requestLatestRun.includes('--expected-latest-id "$EXPECTED_LATEST_ID"') ||
    !requestLatestRun.includes('--expected-latest-tag "$EXPECTED_LATEST_TAG"') ||
    !requestLatestRun.includes(
      '--expected-latest-metadata-sha256 "$EXPECTED_LATEST_METADATA_SHA256"',
    ) ||
    !exactStringSet(reconcileLatest.needs, ["sign-macos", "publish-assets", "request-latest"]) ||
    mapping(reconcileLatest.permissions, "latest reconciliation permissions", issues).contents !==
      "read" ||
    !reconcileLatestRun.includes("desktop-release:transaction reconcile") ||
    reconcileLatestRun.includes("desktop-release:transaction promote") ||
    reconcileLatestRun.includes("--expected-latest-")
  ) {
    issues.push(
      "desktop latest request must compare-and-swap before read-only latest reconciliation",
    );
  }

  if (
    roundTrip.if !== "${{ inputs.mode == 'steady' }}" ||
    !exactStringSet(roundTrip.needs, ["sign-macos", "reconcile-latest"]) ||
    !roundTripRun.includes("desktop-release:transaction public-envelope") ||
    countShellLine(
      roundTripRun,
      "pnpm --filter @enduragent/desktop test:macos-update-roundtrip \\",
    ) !== 1 ||
    !roundTripRun.includes('"$RUNNER_TEMP/desktop-baseline"') ||
    !roundTripRun.includes('"$CANDIDATE_ENVELOPE"') ||
    !roundTripRun.includes('"$EVIDENCE"') ||
    !scalar(roundTrip).includes("desktop-update-evidence-") ||
    !scalar(roundTrip).includes("needs.sign-macos.outputs.baseline_version")
  ) {
    issues.push("steady publication must pass a native production-feed N-to-N+1 round trip");
  }

  const activateCondition = scalar(activate.if).replace(/\s+/gu, " ");
  if (
    !exactStringSet(activate.needs, [
      "sign-macos",
      "publish-assets",
      "request-latest",
      "reconcile-latest",
      "verify-production-update",
    ]) ||
    !activateCondition.includes("always()") ||
    !activateCondition.includes("needs.publish-assets.result == 'success'") ||
    !activateCondition.includes("needs.reconcile-latest.result == 'success'") ||
    !activateCondition.includes("inputs.mode == 'genesis'") ||
    !activateCondition.includes("needs.verify-production-update.result == 'skipped'") ||
    !activateCondition.includes("inputs.mode == 'steady'") ||
    !activateCondition.includes("needs.verify-production-update.result == 'success'") ||
    !activateRun.includes("desktop-release:transaction activate") ||
    !activateRun.includes("apps/desktop/CHANGELOG.md") ||
    activateRun.includes("packages/cycling-coach/CHANGELOG.md")
  ) {
    issues.push(
      "desktop activation must follow mode-specific acceptance and desktop release notes",
    );
  }
  const compensateCondition = scalar(compensate.if).replace(/\s+/gu, " ");
  const compensateStep = namedStep(compensate, "Restore prior latest and withdraw candidate");
  const compensateEnvironment = mapping(
    compensateStep?.env,
    "desktop compensation environment",
    issues,
  );
  if (
    !exactStringSet(compensate.needs, [
      "sign-macos",
      "publish-assets",
      "request-latest",
      "reconcile-latest",
      "verify-production-update",
      "activate-release",
    ]) ||
    !compensateCondition.includes("always()") ||
    !compensateCondition.includes("needs.publish-assets.outputs.latest_id != ''") ||
    !compensateCondition.includes("needs.reconcile-latest.result == 'success'") ||
    !compensateCondition.includes("needs.activate-release.result != 'success'") ||
    !compensateRun.includes("desktop-release:transaction compensate") ||
    !compensateRun.includes("apps/desktop/CHANGELOG.md") ||
    !compensateRun.includes('--expected-latest-id "$EXPECTED_LATEST_ID"') ||
    !compensateRun.includes('--expected-latest-tag "$EXPECTED_LATEST_TAG"') ||
    !compensateRun.includes('--expected-latest-metadata-sha256 "$EXPECTED_LATEST_METADATA_SHA256"')
  ) {
    issues.push(
      "desktop compensation must require successful reconciliation and later acceptance or activation failure",
    );
  }
  if (
    compensateEnvironment.EXPECTED_LATEST_ID !==
      "${{ needs.publish-assets.outputs.rollback_latest_id }}" ||
    compensateEnvironment.EXPECTED_LATEST_TAG !==
      "${{ needs.publish-assets.outputs.rollback_latest_tag }}" ||
    compensateEnvironment.EXPECTED_LATEST_METADATA_SHA256 !==
      "${{ needs.publish-assets.outputs.rollback_latest_metadata_sha256 }}" ||
    !compensateRun.includes('--expected-latest-id "$EXPECTED_LATEST_ID"') ||
    !compensateRun.includes('--expected-latest-tag "$EXPECTED_LATEST_TAG"') ||
    !compensateRun.includes('--expected-latest-metadata-sha256 "$EXPECTED_LATEST_METADATA_SHA256"')
  ) {
    issues.push("desktop rollback must remain bound to normalized manifest baseline evidence");
  }

  const signingSteps = steps(sign);
  const signingStep = namedStep(sign, "Build signed and notarized macOS envelope");
  const installIndex = signingSteps.findIndex(
    (step) => step.run === "pnpm install --frozen-lockfile",
  );
  const workspaceBuildIndex = signingSteps.findIndex((step) => step.run === "pnpm -r build");
  const packageIndex = signingSteps.indexOf(signingStep ?? {});
  const signingEnvironment = mapping(signingStep?.env, "macOS signing environment", issues);
  const signingRun = typeof signingStep?.run === "string" ? signingStep.run : "";
  const cleanupStep = namedStep(sign, "Remove temporary notarization key");
  const cleanupRun = typeof cleanupStep?.run === "string" ? cleanupStep.run : "";
  const keyCreation = signingRun.indexOf(
    'printf \'%s\' "$APPLE_API_KEY_P8_BASE64" | base64 -D > "$APPLE_API_KEY"',
  );
  const privateUmask = signingRun.indexOf("umask 077");
  checkRecoveryOverlay(
    sign,
    "manual signing recovery",
    [
      "apps/desktop/scripts/macos-release-cli.mjs",
      "apps/desktop/scripts/macos-release-plan.mjs",
      "tools/desktop-release-transaction.ts",
    ],
    true,
    issues,
  );
  for (const [jobName, job] of [
    ["verify-macos-envelope", verify],
    ["stage-private-draft", stage],
    ["publish-assets", publish],
    ["request-latest", requestLatest],
    ["reconcile-latest", reconcileLatest],
    ["verify-production-update", roundTrip],
    ["activate-release", activate],
    ["compensate-publication", compensate],
  ] as const) {
    checkRecoveryOverlay(
      job,
      `${jobName} recovery`,
      ["tools/desktop-release-transaction.ts"],
      false,
      issues,
    );
  }
  const workspaceBuildStep = signingSteps.find((step) => step.run === "pnpm -r build");
  const baselineStep = namedStep(sign, "Resolve signed baseline");
  const signingEvidenceStep = namedStep(sign, "Bind candidate signing evidence");
  const sealStep = namedStep(sign, "Seal digest-bound release manifest");
  const sealedUploadStep = namedStep(sign, "Upload sealed macOS transaction artifact");
  const baselineUploadStep = namedStep(sign, "Upload sealed baseline updater envelope");
  const resumedArtifactStep = namedStep(sign, "Download resumed sealed macOS transaction artifact");
  const resumedBaselineStep = namedStep(sign, "Download resumed sealed baseline updater envelope");
  const resumedEvidenceStep = namedStep(sign, "Verify resumed artifact and manifest bindings");
  const resumedEvidenceRun =
    typeof resumedEvidenceStep?.run === "string" ? resumedEvidenceStep.run : "";
  const freshOnly = "${{ inputs.source_run_id == 'none' }}";
  const resumedOnly = "${{ inputs.source_run_id != 'none' }}";
  if (
    workspaceBuildStep?.if !== freshOnly ||
    baselineStep?.if !== freshOnly ||
    signingStep?.if !== freshOnly ||
    signingEvidenceStep?.if !== freshOnly ||
    cleanupStep?.if !== "${{ always() && inputs.source_run_id == 'none' }}" ||
    sealStep?.if !== freshOnly ||
    sealedUploadStep?.if !== freshOnly ||
    baselineUploadStep?.if !== "${{ inputs.source_run_id == 'none' && inputs.mode == 'steady' }}" ||
    resumedArtifactStep?.if !== resumedOnly ||
    resumedBaselineStep?.if !== resumedOnly ||
    resumedEvidenceStep?.if !== resumedOnly
  ) {
    issues.push(
      "desktop resume must skip build, signing, notarization, sealing, and signing-artifact upload",
    );
  }
  const resumedDownloadSpecifications = [
    {
      step: resumedArtifactStep,
      artifactId: "${{ needs.authorize-coordinator.outputs.artifact_id }}",
      path: "${{ runner.temp }}/desktop-release",
    },
    {
      step: resumedBaselineStep,
      artifactId: "${{ needs.authorize-coordinator.outputs.baseline_artifact_id }}",
      path: "${{ runner.temp }}/desktop-baseline",
    },
  ];
  if (
    resumedDownloadSpecifications.some(({ step, artifactId, path }) => {
      const withInputs = mapping(step?.with, "resumed artifact download inputs", issues);
      return (
        typeof step?.uses !== "string" ||
        !step.uses.startsWith("actions/download-artifact@") ||
        !exactKeys(withInputs, [
          "artifact-ids",
          "path",
          "github-token",
          "repository",
          "run-id",
          "digest-mismatch",
        ]) ||
        withInputs["artifact-ids"] !== artifactId ||
        withInputs.path !== path ||
        withInputs["github-token"] !== "${{ github.token }}" ||
        withInputs.repository !== "${{ github.repository }}" ||
        withInputs["run-id"] !== "${{ needs.authorize-coordinator.outputs.source_run_id }}" ||
        withInputs["digest-mismatch"] !== "error"
      );
    }) ||
    !resumedEvidenceRun.includes(
      'test "$ARTIFACT_NAME" = "desktop-release-$SOURCE_RUN_ID-$SOURCE_RUN_ATTEMPT"',
    ) ||
    !resumedEvidenceRun.includes(
      'test "$BASELINE_ARTIFACT_NAME" = "desktop-baseline-$SOURCE_RUN_ID-$SOURCE_RUN_ATTEMPT"',
    ) ||
    !resumedEvidenceRun.includes(
      'test "$(jq -er \'.workflowRunId\' "$MANIFEST")" = "$SOURCE_RUN_ID"',
    ) ||
    !resumedEvidenceRun.includes(
      'test "$(jq -er \'.workflowRunAttempt\' "$MANIFEST")" = "$SOURCE_RUN_ATTEMPT"',
    ) ||
    !resumedEvidenceRun.includes('--workflow-run-id "$SOURCE_RUN_ID"') ||
    !resumedEvidenceRun.includes('--workflow-run-attempt "$SOURCE_RUN_ATTEMPT"')
  ) {
    issues.push("desktop resume must reuse exact digest-bound artifacts from the authorized run");
  }

  const normalizedStep = namedStep(sign, "Normalize immutable signing and artifact evidence");
  const normalizedRun = typeof normalizedStep?.run === "string" ? normalizedStep.run : "";
  const signOutputs = mapping(sign.outputs, "macOS signing outputs", issues);
  const expectedSignOutputs: Mapping = {
    baseline_tag: "${{ steps.normalized-evidence.outputs.baseline_tag }}",
    baseline_version: "${{ steps.normalized-evidence.outputs.baseline_version }}",
    baseline_release_id: "${{ steps.normalized-evidence.outputs.baseline_release_id }}",
    baseline_commit: "${{ steps.normalized-evidence.outputs.baseline_commit }}",
    baseline_zip_sha256: "${{ steps.normalized-evidence.outputs.baseline_zip_sha256 }}",
    baseline_metadata_sha256: "${{ steps.normalized-evidence.outputs.baseline_metadata_sha256 }}",
    baseline_signing_identity: "${{ steps.normalized-evidence.outputs.baseline_signing_identity }}",
    baseline_cdhash: "${{ steps.normalized-evidence.outputs.baseline_cdhash }}",
    baseline_artifact_name: "${{ steps.normalized-evidence.outputs.baseline_artifact_name }}",
    baseline_artifact_id: "${{ steps.normalized-evidence.outputs.baseline_artifact_id }}",
    baseline_artifact_digest: "${{ steps.normalized-evidence.outputs.baseline_artifact_digest }}",
    cdhash: "${{ steps.normalized-evidence.outputs.cdhash }}",
    code_directory_sha256: "${{ steps.normalized-evidence.outputs.code_directory_sha256 }}",
    signing_identity: "${{ steps.normalized-evidence.outputs.signing_identity }}",
    evidence_run_id: "${{ steps.normalized-evidence.outputs.evidence_run_id }}",
    evidence_run_attempt: "${{ steps.normalized-evidence.outputs.evidence_run_attempt }}",
    artifact_name: "${{ steps.normalized-evidence.outputs.artifact_name }}",
    artifact_id: "${{ steps.normalized-evidence.outputs.artifact_id }}",
    artifact_digest: "${{ steps.normalized-evidence.outputs.artifact_digest }}",
  };
  if (
    normalizedStep?.id !== "normalized-evidence" ||
    !exactKeys(signOutputs, Object.keys(expectedSignOutputs)) ||
    Object.entries(expectedSignOutputs).some(([key, value]) => signOutputs[key] !== value) ||
    !normalizedRun.includes("if [ \"$SOURCE_RUN_ID\" = 'none' ]; then") ||
    !normalizedRun.includes('EVIDENCE_RUN_ID="$GITHUB_RUN_ID"') ||
    !normalizedRun.includes('EVIDENCE_RUN_ATTEMPT="$GITHUB_RUN_ATTEMPT"') ||
    !normalizedRun.includes('EVIDENCE_RUN_ID="$SOURCE_RUN_ID"') ||
    !normalizedRun.includes('EVIDENCE_RUN_ATTEMPT="$SOURCE_RUN_ATTEMPT"') ||
    !normalizedRun.includes('ARTIFACT_ID="$FRESH_ARTIFACT_ID"') ||
    !normalizedRun.includes('ARTIFACT_ID="$SOURCE_ARTIFACT_ID"') ||
    !normalizedRun.includes('ARTIFACT_DIGEST="${FRESH_ARTIFACT_DIGEST#sha256:}"') ||
    !normalizedRun.includes('ARTIFACT_DIGEST="$SOURCE_ARTIFACT_DIGEST"') ||
    !normalizedRun.includes('BASELINE_METADATA_SHA256="$FRESH_BASELINE_METADATA_SHA256"') ||
    !normalizedRun.includes('BASELINE_METADATA_SHA256="$RESUMED_BASELINE_METADATA_SHA256"') ||
    !normalizedRun.includes(
      'test "$ARTIFACT_NAME" = "desktop-release-$EVIDENCE_RUN_ID-$EVIDENCE_RUN_ATTEMPT"',
    ) ||
    !normalizedRun.includes(
      'test "$BASELINE_ARTIFACT_NAME" = "desktop-baseline-$EVIDENCE_RUN_ID-$EVIDENCE_RUN_ATTEMPT"',
    ) ||
    !normalizedRun.includes('echo "evidence_run_id=$EVIDENCE_RUN_ID" >> "$GITHUB_OUTPUT"') ||
    !normalizedRun.includes(
      'echo "baseline_metadata_sha256=$BASELINE_METADATA_SHA256" >> "$GITHUB_OUTPUT"',
    ) ||
    !normalizedRun.includes('echo "evidence_run_attempt=$EVIDENCE_RUN_ATTEMPT" >> "$GITHUB_OUTPUT"')
  ) {
    issues.push("desktop signing must normalize fresh and resumed immutable evidence");
  }
  if (
    installIndex === -1 ||
    workspaceBuildIndex <= installIndex ||
    workspaceBuildIndex >= packageIndex
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
    !source.includes('--desktop-version "$DESKTOP_VERSION"') ||
    !source.includes('--candidate-tag "$RELEASE_TAG"') ||
    nonSigningText.includes("package:mac")
  ) {
    issues.push("signing must dispatch explicit genesis and steady desktop packaging modes");
  }
  if (
    keyCreation === -1 ||
    privateUmask === -1 ||
    privateUmask > keyCreation ||
    signingEnvironment.APPLE_API_KEY !== "${{ runner.temp }}/AuthKey.p8" ||
    cleanupStep?.if !== "${{ always() && inputs.source_run_id == 'none' }}" ||
    signingSteps.indexOf(cleanupStep ?? {}) <= signingSteps.indexOf(signingStep ?? {}) ||
    countShellLine(cleanupRun, 'rm -f "$RUNNER_TEMP/AuthKey.p8"') !== 1
  ) {
    issues.push("temporary notarization key must be created privately and always removed");
  }

  const independentBaselineStep = namedStep(verify, "Resolve independent baseline");
  const independentBaselineEnvironment = mapping(
    independentBaselineStep?.env,
    "independent baseline environment",
    issues,
  );
  const confirmBaselineStep = namedStep(verify, "Confirm independently resolved baseline evidence");
  const confirmBaselineEnvironment = mapping(
    confirmBaselineStep?.env,
    "independent baseline confirmation environment",
    issues,
  );
  const confirmBaselineRun =
    typeof confirmBaselineStep?.run === "string" ? confirmBaselineStep.run : "";
  const independentStep = namedStep(verify, "Independently verify signed updater envelope");
  const independentEnvironment = mapping(
    independentStep?.env,
    "independent macOS verification environment",
    issues,
  );
  const independentRun = typeof independentStep?.run === "string" ? independentStep.run : "";
  const transactionVerification = independentRun.indexOf("desktop-release:transaction verify");
  const publicEnvelope = independentRun.indexOf("desktop-release:transaction public-envelope");
  const genesisVerification = independentRun.indexOf(
    "verify:mac-genesis-release \\",
    publicEnvelope,
  );
  const steadyVerification = independentRun.indexOf("verify:mac-release \\", publicEnvelope);
  const genesisCase = independentRun.slice(
    independentRun.indexOf("genesis)", publicEnvelope),
    independentRun.indexOf(";;", independentRun.indexOf("genesis)", publicEnvelope)),
  );
  const steadyCase = independentRun.slice(
    independentRun.indexOf("steady)", publicEnvelope),
    independentRun.indexOf(";;", independentRun.indexOf("steady)", publicEnvelope)),
  );
  if (
    independentBaselineEnvironment.RELEASE_BASELINE_TAG !==
      "${{ needs.sign-macos.outputs.baseline_tag }}" ||
    confirmBaselineEnvironment.INDEPENDENT_METADATA_SHA256 !==
      "${{ steps.independent-baseline.outputs.baseline_metadata_sha256 }}" ||
    confirmBaselineEnvironment.SIGNED_METADATA_SHA256 !==
      "${{ needs.sign-macos.outputs.baseline_metadata_sha256 }}" ||
    !confirmBaselineRun.includes('test "$INDEPENDENT_METADATA_SHA256" = "$SIGNED_METADATA_SHA256"')
  ) {
    issues.push("desktop baseline consumers must use normalized manifest evidence");
  }
  if (
    transactionVerification === -1 ||
    publicEnvelope <= transactionVerification ||
    genesisVerification <= publicEnvelope ||
    steadyVerification <= publicEnvelope ||
    independentEnvironment.RELEASE_MODE !== "${{ inputs.mode }}" ||
    countShellLine(independentRun, 'case "$RELEASE_MODE" in') !== 1 ||
    countShellLine(
      independentRun,
      "pnpm --filter @enduragent/desktop verify:mac-genesis-release \\",
    ) !== 1 ||
    countShellLine(independentRun, "pnpm --filter @enduragent/desktop verify:mac-release \\") !==
      1 ||
    (independentRun.slice(publicEnvelope).match(/"\$PUBLIC_ENVELOPE"/gu) ?? []).length !== 3 ||
    !genesisCase.includes('"$PUBLIC_ENVELOPE"') ||
    !genesisCase.includes('"$CANDIDATE_APP"') ||
    genesisCase.includes("$INDEPENDENT_BASELINE_APP") ||
    !steadyCase.includes('"$PUBLIC_ENVELOPE"') ||
    !steadyCase.includes('"$INDEPENDENT_BASELINE_APP"') ||
    !steadyCase.includes('"$CANDIDATE_APP"') ||
    source.split("\\(FA494ACVTF\\)$").length - 1 !== 6 ||
    countShellLine(independentRun, 'test "$INDEPENDENT_CDHASH" = "$CANDIDATE_CDHASH"') !== 1 ||
    countShellLine(
      independentRun,
      'test "$INDEPENDENT_CODE_DIRECTORY_SHA256" = "$CANDIDATE_CODE_DIRECTORY_SHA256"',
    ) !== 1 ||
    countShellLine(independentRun, 'test "$INDEPENDENT_SIGNING_IDENTITY" = "$SIGNING_IDENTITY"') !==
      1
  ) {
    issues.push("native verification must consume the signed exact-four public envelope");
  }
  if (
    independentEnvironment.WORKFLOW_RUN_ID !== "${{ needs.sign-macos.outputs.evidence_run_id }}" ||
    independentEnvironment.SIGNING_RUN_ATTEMPT !==
      "${{ needs.sign-macos.outputs.evidence_run_attempt }}" ||
    !independentRun.includes('--workflow-run-id "$WORKFLOW_RUN_ID"') ||
    !independentRun.includes('--workflow-run-attempt "$SIGNING_RUN_ATTEMPT"') ||
    source.includes("SIGNING_RUN_ATTEMPT: ${{ github.run_attempt }}")
  ) {
    issues.push("desktop verification must bind normalized immutable signing evidence");
  }

  const candidateConsumers = [
    ["verify-macos-envelope", verify],
    ["stage-private-draft", stage],
    ["publish-assets", publish],
    ["request-latest", requestLatest],
    ["reconcile-latest", reconcileLatest],
    ["verify-production-update", roundTrip],
    ["activate-release", activate],
    ["compensate-publication", compensate],
  ] as const;
  let invalidNormalizedDownload = false;
  for (const [jobName, job] of candidateConsumers) {
    const downloads = actionSteps(job, "actions/download-artifact");
    const candidateDownloads = downloads.filter(
      (step) =>
        mapping(step.with, `${jobName} download inputs`, issues).path ===
        "${{ runner.temp }}/desktop-release",
    );
    if (candidateDownloads.length !== 1) {
      invalidNormalizedDownload = true;
      continue;
    }
    const withInputs = mapping(
      candidateDownloads[0].with,
      `${jobName} candidate download inputs`,
      issues,
    );
    if (
      !exactKeys(withInputs, [
        "artifact-ids",
        "path",
        "github-token",
        "repository",
        "run-id",
        "digest-mismatch",
      ]) ||
      withInputs["artifact-ids"] !== "${{ needs.sign-macos.outputs.artifact_id }}" ||
      withInputs["github-token"] !== "${{ github.token }}" ||
      withInputs.repository !== "${{ github.repository }}" ||
      withInputs["run-id"] !== "${{ needs.sign-macos.outputs.evidence_run_id }}" ||
      withInputs["digest-mismatch"] !== "error"
    ) {
      invalidNormalizedDownload = true;
    }
  }
  const baselineDownloads = actionSteps(roundTrip, "actions/download-artifact").filter(
    (step) =>
      mapping(step.with, "production baseline download inputs", issues).path ===
      "${{ runner.temp }}/desktop-baseline",
  );
  if (baselineDownloads.length !== 1) {
    invalidNormalizedDownload = true;
  } else {
    const withInputs = mapping(
      baselineDownloads[0].with,
      "production baseline download inputs",
      issues,
    );
    if (
      !exactKeys(withInputs, [
        "artifact-ids",
        "path",
        "github-token",
        "repository",
        "run-id",
        "digest-mismatch",
      ]) ||
      withInputs["artifact-ids"] !== "${{ needs.sign-macos.outputs.baseline_artifact_id }}" ||
      withInputs["github-token"] !== "${{ github.token }}" ||
      withInputs.repository !== "${{ github.repository }}" ||
      withInputs["run-id"] !== "${{ needs.sign-macos.outputs.evidence_run_id }}" ||
      withInputs["digest-mismatch"] !== "error"
    ) {
      invalidNormalizedDownload = true;
    }
  }
  if (
    invalidNormalizedDownload ||
    actionSteps(sign, "actions/download-artifact").length !== 2 ||
    (source.match(/actions\/download-artifact@[^\n]+# v8/gu) ?? []).length !== 11 ||
    (source.match(/digest-mismatch: error/gu) ?? []).length !== 11
  ) {
    issues.push("desktop artifact downloads must use normalized digest-bound cross-run evidence");
  }
}

function checkVersionDispatch(version: Mapping, issues: string[]): void {
  requireQueue(version.concurrency, "version-pr", "version dispatcher", issues);
  const jobs = mapping(version.jobs, "version.jobs", issues);
  const versionJob = mapping(jobs["version-pr"], "version.jobs.version-pr", issues);
  const versionText = runs(versionJob).join("\n");
  const previousPackageVersion = versionText.indexOf(
    "PREVIOUS_VERSION=$(git show \"$PREVIOUS_COMMIT:$pkg_json\" | jq -er '.version')",
  );
  const packageSkip = versionText.indexOf('if [ "$VERSION" = "$PREVIOUS_VERSION" ]; then');
  const packageTag = versionText.indexOf('TAG="$NAME@$VERSION"');
  if (
    !versionText.includes("PREVIOUS_COMMIT=$(git rev-parse HEAD^)") ||
    previousPackageVersion === -1 ||
    packageSkip <= previousPackageVersion ||
    packageTag <= packageSkip ||
    !versionText.slice(packageSkip, packageTag).includes("continue") ||
    !versionText.includes('git rev-parse "refs/tags/$TAG^{commit}"') ||
    !versionText.includes('"$TAG_COMMIT" != "$RELEASE_COMMIT"') ||
    !versionText.includes('gh workflow run release.yml --ref "$TAG" -f tag="$TAG"') ||
    versionText.includes("Tag $TAG already on origin — skipping")
  ) {
    issues.push(
      "version dispatcher must skip unchanged npm versions and verify exact changed tags",
    );
  }
  if (
    !versionText.includes("DESKTOP_PACKAGE_JSON=apps/desktop/package.json") ||
    !versionText.includes("DESKTOP_VERSION=$(jq -er '.version' \"$DESKTOP_PACKAGE_JSON\")") ||
    !versionText.includes(
      "PREVIOUS_DESKTOP_VERSION=$(git show \"$PREVIOUS_COMMIT:$DESKTOP_PACKAGE_JSON\" | jq -er '.version')",
    ) ||
    !versionText.includes('if [ "$DESKTOP_VERSION" = "$PREVIOUS_DESKTOP_VERSION" ]; then') ||
    !versionText.includes("skipping desktop release") ||
    !versionText.includes('DESKTOP_TAG="enduragent-desktop@$DESKTOP_VERSION"') ||
    !versionText.includes('git rev-parse "refs/tags/$DESKTOP_TAG^{commit}"') ||
    !versionText.includes('"$DESKTOP_TAG_COMMIT" != "$RELEASE_COMMIT"') ||
    !versionText.includes(
      'gh workflow run desktop-release-coordinator.yml --ref "$DESKTOP_TAG" \\',
    ) ||
    !versionText.includes('-f tag="$DESKTOP_TAG" -f desktop_mode=steady') ||
    versionText.includes("gh workflow run desktop-release.yml") ||
    (versionText.match(/for attempt in \$\(seq 1 6\)/gu) ?? []).length < 2
  ) {
    issues.push("version dispatcher must independently tag and dispatch changed desktop SemVer");
  }
}

export function inspectDesktopReleaseWorkflows(
  releaseSource: string,
  coordinatorSource: string,
  desktopSource: string,
  versionSource: string,
): string[] {
  const issues: string[] = [];
  let release: Mapping;
  let coordinator: Mapping;
  let desktop: Mapping;
  let version: Mapping;
  try {
    release = mapping(parse(releaseSource), "npm release workflow", issues);
    coordinator = mapping(parse(coordinatorSource), "desktop coordinator workflow", issues);
    desktop = mapping(parse(desktopSource), "desktop child workflow", issues);
    version = mapping(parse(versionSource), "version workflow", issues);
  } catch {
    return ["release workflows must be valid YAML"];
  }

  if (
    coordinatorSource.includes("desktop-release:transaction --") ||
    desktopSource.includes("desktop-release:transaction --") ||
    releaseSource.includes("desktop-release:transaction --")
  ) {
    issues.push("release transaction commands must not pass a pnpm argument separator");
  }
  checkCheckouts(release, "npm release", issues);
  checkCheckouts(coordinator, "desktop coordinator", issues);
  checkCheckouts(desktop, "desktop child", issues);
  checkCheckouts(version, "version", issues);
  checkNpmRelease(releaseSource, release, issues);
  checkCoordinator(coordinatorSource, coordinator, issues);
  checkDesktopChild(desktopSource, desktop, issues);
  checkVersionDispatch(version, issues);
  return issues;
}

export function main(): void {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const issues = inspectDesktopReleaseWorkflows(
    readFileSync(resolve(root, ".github/workflows/release.yml"), "utf8"),
    readFileSync(resolve(root, ".github/workflows/desktop-release-coordinator.yml"), "utf8"),
    readFileSync(resolve(root, ".github/workflows/desktop-release.yml"), "utf8"),
    readFileSync(resolve(root, ".github/workflows/version-pr.yml"), "utf8"),
  );
  if (issues.length > 0) {
    throw new TypeError(issues.map((issue) => `- ${issue}`).join("\n"));
  }
  process.stdout.write("Desktop release workflow structure verified\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
