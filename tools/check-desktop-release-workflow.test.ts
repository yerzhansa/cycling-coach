import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { inspectDesktopReleaseWorkflows } from "./check-desktop-release-workflow.js";

const releasePath = resolve(".github/workflows/release.yml");
const coordinatorPath = resolve(".github/workflows/desktop-release-coordinator.yml");
const desktopPath = resolve(".github/workflows/desktop-release.yml");
const versionPath = resolve(".github/workflows/version-pr.yml");
const npmViewFixturePath = resolve("tools/fixtures/npm-view-cycling-coach-2026.7.28.json");

interface WorkflowSources {
  release: string;
  coordinator: string;
  desktop: string;
  version: string;
}

function sources(): WorkflowSources {
  return {
    release: readFileSync(releasePath, "utf8"),
    coordinator: readFileSync(coordinatorPath, "utf8"),
    desktop: readFileSync(desktopPath, "utf8"),
    version: readFileSync(versionPath, "utf8"),
  };
}

function inspect(source: WorkflowSources): string[] {
  return inspectDesktopReleaseWorkflows(
    source.release,
    source.coordinator,
    source.desktop,
    source.version,
  );
}

function replaceRequired(source: string, search: string, replacement: string): string {
  if (!source.includes(search)) throw new TypeError(`Mutation target not found: ${search}`);
  return source.replace(search, () => replacement);
}

function expectIssue(source: WorkflowSources, fragment: string): void {
  expect(inspect(source).some((issue) => issue.includes(fragment))).toBe(true);
}

describe("desktop release workflow policy", () => {
  it("accepts the npm-independent desktop coordinator chain", () => {
    const source = sources();
    expect(inspect(source)).toEqual([]);
    expect(source.coordinator).toContain("^enduragent-desktop@");
    expect(source.coordinator).toContain('git show "$COMMIT:apps/desktop/package.json"');
    expect(source.coordinator).toContain("uses: ./.github/workflows/desktop-release.yml");
    expect(source.desktop).toContain(".github/workflows/desktop-release-coordinator.yml");
    expect(source.desktop).not.toMatch(/\bnpm_(?:version|integrity|attestation_url)\b/u);
    expect(source.version).toContain('DESKTOP_TAG="enduragent-desktop@$DESKTOP_VERSION"');
  });

  it("requires the stable desktop tag namespace, manifest version, and exact tag ref", () => {
    const source = sources();
    const mutations = [
      replaceRequired(
        source.coordinator,
        "^enduragent-desktop@(0|[1-9][0-9]*)",
        "^cycling-coach@(0|[1-9][0-9]*)",
      ),
      replaceRequired(
        source.coordinator,
        'if [ "$MANIFEST_VERSION" != "$VERSION" ]; then',
        "if false; then",
      ),
      replaceRequired(
        source.coordinator,
        'test "$WORKFLOW_REF" = "refs/tags/$TAG"',
        'test "$WORKFLOW_REF" = "refs/heads/main"',
      ),
      replaceRequired(
        source.coordinator,
        'test "$WORKFLOW_SHA" = "$COMMIT"',
        'test "$WORKFLOW_SHA" != "$COMMIT"',
      ),
    ];
    for (const coordinator of mutations) {
      expectIssue({ ...source, coordinator }, "stable enduragent-desktop SemVer");
    }
  });

  it("requires an optional immutable recovery tooling tag", () => {
    const source = sources();
    const recoveryInput = [
      "      recovery_tooling_tag:",
      '        description: "Optional immutable enduragent-desktop@<version>-recovery.<revision> tooling tag"',
      "        required: false",
      '        default: ""',
      "        type: string",
    ].join("\n");
    const coordinator = replaceRequired(
      source.coordinator,
      recoveryInput,
      recoveryInput.replace("required: false", "required: true"),
    );
    expectIssue({ ...source, coordinator }, "recovery tooling tag must be an optional string");
  });

  it("requires an optional recovery source run guarded by steady recovery tooling", () => {
    const source = sources();
    const requiredSource = replaceRequired(
      source.coordinator,
      [
        "      recovery_source_run_id:",
        '        description: "Optional failed desktop release run whose immutable signed artifacts should be resumed"',
        "        required: false",
        '        default: ""',
        "        type: string",
      ].join("\n"),
      [
        "      recovery_source_run_id:",
        '        description: "Optional failed desktop release run whose immutable signed artifacts should be resumed"',
        "        required: true",
        '        default: ""',
        "        type: string",
      ].join("\n"),
    );
    expectIssue({ ...source, coordinator: requiredSource }, "source run id must be an optional");

    const unguardedSource = replaceRequired(
      source.coordinator,
      'if [ -z "$RECOVERY_TOOLING_TAG_INPUT" ] || [ "$MODE" != \'steady\' ]; then',
      "if false; then",
    );
    expectIssue(
      { ...source, coordinator: unguardedSource },
      "source run must require a steady immutable recovery tag",
    );
  });

  it("requires independent coordinator source run, job, and artifact provenance", () => {
    const source = sources();
    const mutations = [
      replaceRequired(
        source.coordinator,
        "actions/runs/$SOURCE_RUN_ID/attempts/$SOURCE_ATTEMPT/jobs?per_page=100",
        "actions/runs/$SOURCE_RUN_ID/jobs?per_page=1",
      ),
      replaceRequired(
        source.coordinator,
        "for required_job in sign-macos verify-macos-envelope stage-private-draft publish-assets; do",
        "for required_job in sign-macos verify-macos-envelope stage-private-draft; do",
      ),
      replaceRequired(
        source.coordinator,
        'test "$(printf \'%s\' "$ARTIFACT" | jq -r \'.workflow_run.head_sha\')" = "$SOURCE_SHA"',
        "true",
      ),
      replaceRequired(
        source.coordinator,
        'test "$(printf \'%s\' "$SOURCE_RUN" | jq -r \'.head_repository.full_name\')" = "$GITHUB_REPOSITORY"',
        "true",
      ),
      replaceRequired(
        source.coordinator,
        "          REPOSITORY_ID: ${{ github.repository_id }}",
        "          REPOSITORY_ID: ${{ github.repository }}",
      ),
      source.coordinator.replaceAll(
        ".workflow_run.head_repository_id",
        ".workflow_run.repository_id",
      ),
    ];
    for (const coordinator of mutations) {
      expectIssue(
        { ...source, coordinator },
        "independently validate source run, job, and artifact provenance",
      );
    }
  });

  it("allows only legacy-bot or reusable-coordinator source provenance in coordinator preflight", () => {
    const source = sources();
    const mutations = [
      replaceRequired(
        source.coordinator,
        'SOURCE_WORKFLOW_PATH="${SOURCE_WORKFLOW_PATH_RAW%%@*}"',
        'SOURCE_WORKFLOW_PATH="$SOURCE_WORKFLOW_PATH_RAW"',
      ),
      replaceRequired(
        source.coordinator,
        "              .github/workflows/desktop-release.yml)",
        "              .github/workflows/release.yml)",
      ),
      replaceRequired(
        source.coordinator,
        "              .github/workflows/desktop-release-coordinator.yml)\n                ;;",
        "              .github/workflows/desktop-release-coordinator.yml)\n                ;;\n              .github/workflows/release.yml)\n                ;;",
      ),
      replaceRequired(
        source.coordinator,
        "                test \"$(printf '%s' \"$SOURCE_RUN\" | jq -r '.actor.login')\" = 'github-actions[bot]'",
        "                true",
      ),
      replaceRequired(
        source.coordinator,
        "                test \"$(printf '%s' \"$SOURCE_RUN\" | jq -r '.triggering_actor.login')\" = 'github-actions[bot]'",
        "                true",
      ),
      replaceRequired(
        source.coordinator,
        "              .github/workflows/desktop-release-coordinator.yml)\n                ;;",
        "              .github/workflows/desktop-release-coordinator.yml)\n                test \"$(printf '%s' \"$SOURCE_RUN\" | jq -r '.actor.login')\" = 'github-actions[bot]'\n                ;;",
      ),
      replaceRequired(
        source.coordinator,
        '"$SOURCE_WORKFLOW_PATH"|"$SOURCE_WORKFLOW_PATH@$SOURCE_HEAD"|"$SOURCE_WORKFLOW_PATH@refs/tags/$SOURCE_HEAD")',
        '"$SOURCE_WORKFLOW_PATH"*)',
      ),
      replaceRequired(
        source.coordinator,
        "            test \"$(printf '%s' \"$SOURCE_RUN\" | jq -r '.event')\" = 'workflow_dispatch'",
        "            true",
      ),
      replaceRequired(
        source.coordinator,
        '            test "$(printf \'%s\' "$SOURCE_RUN" | jq -r \'.repository.full_name\')" = "$GITHUB_REPOSITORY"',
        "            true",
      ),
    ];
    for (const coordinator of mutations) {
      expectIssue(
        { ...source, coordinator },
        "independently validate source run, job, and artifact provenance",
      );
    }
  });

  it("accepts only the candidate or an earlier recovery source in coordinator preflight", () => {
    const source = sources();
    const mutations = [
      replaceRequired(source.coordinator, 'test "$SOURCE_SHA" = "$COMMIT"', "true"),
      replaceRequired(
        source.coordinator,
        "printf '%s' \"$SOURCE_REVISION\" | grep -Eq '^[1-9][0-9]*$'",
        "printf '%s' \"$SOURCE_REVISION\" | grep -Eq '^[0-9]+$'",
      ),
      replaceRequired(
        source.coordinator,
        'test "$SOURCE_HEAD" = "${TAG}-recovery.${SOURCE_REVISION}"',
        "true",
      ),
      replaceRequired(
        source.coordinator,
        'test "$SOURCE_REVISION" -lt "$CURRENT_RECOVERY_REVISION"',
        'test "$SOURCE_REVISION" != "$CURRENT_RECOVERY_REVISION"',
      ),
      replaceRequired(
        source.coordinator,
        'test "$SOURCE_REVISION" -lt "$CURRENT_RECOVERY_REVISION"',
        'test "$SOURCE_REVISION" -le "$CURRENT_RECOVERY_REVISION"',
      ),
      replaceRequired(
        source.coordinator,
        'test "$(git rev-parse "refs/tags/$SOURCE_HEAD^{commit}")" = "$SOURCE_SHA"',
        "true",
      ),
      replaceRequired(
        source.coordinator,
        'git merge-base --is-ancestor "$COMMIT" "$SOURCE_SHA"',
        'git merge-base --is-ancestor "$SOURCE_SHA" "$COMMIT"',
      ),
      replaceRequired(
        source.coordinator,
        'git merge-base --is-ancestor "$SOURCE_SHA" "$TOOLING_COMMIT"',
        'git merge-base --is-ancestor "$TOOLING_COMMIT" "$SOURCE_SHA"',
      ),
      replaceRequired(
        source.coordinator,
        'git merge-base --is-ancestor "$SOURCE_SHA" refs/remotes/origin/main',
        'git merge-base --is-ancestor "$COMMIT" refs/remotes/origin/main',
      ),
    ];
    for (const coordinator of mutations) {
      expectIssue(
        { ...source, coordinator },
        "independently validate source run, job, and artifact provenance",
      );
    }
  });

  it("requires exact terminal source jobs and a non-successful activation in coordinator preflight", () => {
    const source = sources();
    const mutations = [
      replaceRequired(
        source.coordinator,
        '[.[].jobs[] | select((.name | split(" / ") | last) == $name)] as $matches |',
        "[.[].jobs[] | select(.name | contains($name))] as $matches |",
      ),
      replaceRequired(
        source.coordinator,
        "                ($matches | length) == 1 and",
        "                ($matches | length) > 0 and",
      ),
      replaceRequired(
        source.coordinator,
        '[.[].jobs[] | select((.name | split(" / ") | last) == "activate-release")] as $matches |',
        '[.[].jobs[] | select(.name | contains("activate-release"))] as $matches |',
      ),
      replaceRequired(
        source.coordinator,
        '[.[].jobs[] | select((.name | split(" / ") | last) == "activate-release")] as $matches |\n              ($matches | length) == 1 and',
        '[.[].jobs[] | select((.name | split(" / ") | last) == "activate-release")] as $matches |\n              ($matches | length) > 0 and',
      ),
      replaceRequired(
        source.coordinator,
        '$matches[0].conclusion != "success"',
        '$matches[0].conclusion == "failure"',
      ),
    ];
    for (const coordinator of mutations) {
      expectIssue(
        { ...source, coordinator },
        "independently validate source run, job, and artifact provenance",
      );
    }
  });

  it("keeps source final-state authorization out of the frozen coordinator tuple", () => {
    const source = sources();
    const coordinator = replaceRequired(
      source.coordinator,
      "      source_run_id: ${{ steps.bind.outputs.source_run_id }}\n",
      "      source_run_id: ${{ steps.bind.outputs.source_run_id }}\n      source_final_body_allowed: ${{ steps.bind.outputs.source_final_body_allowed }}\n",
    );
    expectIssue({ ...source, coordinator }, "freeze the candidate release tuple once");
  });

  it("binds recovery tooling to an exact steady-only tag on main", () => {
    const source = sources();
    const mutations = [
      replaceRequired(
        source.coordinator,
        "printf '%s' \"$RECOVERY_REVISION\" | grep -Eq '^[1-9][0-9]*$'",
        "printf '%s' \"$RECOVERY_REVISION\" | grep -Eq '^[0-9]+$'",
      ),
      replaceRequired(
        source.coordinator,
        "if [ \"$MODE\" != 'steady' ]; then",
        "if [ \"$MODE\" != 'genesis' ]; then",
      ),
      replaceRequired(
        source.coordinator,
        'git merge-base --is-ancestor "$COMMIT" "$TOOLING_COMMIT"',
        'git merge-base --is-ancestor "$TOOLING_COMMIT" "$COMMIT"',
      ),
      replaceRequired(
        source.coordinator,
        'git merge-base --is-ancestor "$TOOLING_COMMIT" refs/remotes/origin/main',
        'git merge-base --is-ancestor "$COMMIT" refs/remotes/origin/main',
      ),
      replaceRequired(
        source.coordinator,
        'test "$WORKFLOW_SHA" = "$TOOLING_COMMIT"',
        'test "$WORKFLOW_SHA" = "$COMMIT"',
      ),
    ];
    for (const [index, coordinator] of mutations.entries()) {
      expect(
        inspect({ ...source, coordinator }).some((issue) =>
          issue.includes("distinct immutable steady-only tag"),
        ),
        `recovery mutation ${index}`,
      ).toBe(true);
    }
  });

  it("admits only an exact draft, recovery-provisional public, or live-latest final release", () => {
    const source = sources();
    const mutations = [
      replaceRequired(
        source.coordinator,
        "apps/desktop/CHANGELOG.md",
        "packages/cycling-coach/CHANGELOG.md",
      ),
      replaceRequired(source.coordinator, "--draft --latest=false --target", "--draft --target"),
      replaceRequired(
        source.coordinator,
        "Desktop update validation is in progress. This release is not yet generally available.",
        "A public body that is not the exact provisional sentinel.",
      ),
      replaceRequired(source.coordinator, "test \"$RELEASE_SOURCE_RUN_ID\" != 'none'", "true"),
      replaceRequired(
        source.coordinator,
        '                test "$EXISTING_BODY_SHA256" = "$BODY_SHA256"\n                LATEST_JSON=',
        "                true\n                LATEST_JSON=",
      ),
      replaceRequired(
        source.coordinator,
        "          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
        '          GH_TOKEN: ""',
      ),
      replaceRequired(
        source.coordinator,
        "gh api -H 'Cache-Control: no-cache' \"repos/$GITHUB_REPOSITORY/releases/latest\"",
        'gh api "repos/$GITHUB_REPOSITORY/releases/latest"',
      ),
      replaceRequired(
        source.coordinator,
        "test \"$(printf '%s' \"$LATEST_JSON\" | jq -r '.id | tostring')\" = \"$(printf '%s' \"$RELEASE_JSON\" | jq -r '.databaseId | tostring')\"",
        "true",
      ),
      replaceRequired(
        source.coordinator,
        'test "$(printf \'%s\' "$LATEST_JSON" | jq -r \'.tag_name\')" = "$RELEASE_TAG"',
        "true",
      ),
    ];
    for (const coordinator of mutations) {
      expectIssue({ ...source, coordinator }, "live-latest exact-final release");
    }
  });

  it("never creates a missing candidate while recovering source artifacts", () => {
    const source = sources();
    const coordinator = replaceRequired(
      source.coordinator,
      "          else\n            test \"$RELEASE_SOURCE_RUN_ID\" = 'none'\n            gh release create",
      "          else\n            true\n            gh release create",
    );
    expectIssue({ ...source, coordinator }, "never create a missing candidate release");
  });

  it("calls one exact secretless reusable workflow tuple after the draft safeguard", () => {
    const source = sources();
    const mutations = [
      replaceRequired(
        source.coordinator,
        "    uses: ./.github/workflows/desktop-release.yml",
        "    uses: ./.github/workflows/release.yml",
      ),
      replaceRequired(
        source.coordinator,
        "    needs: [bind-release, prepare-release-draft]",
        "    needs: bind-release",
      ),
      replaceRequired(
        source.coordinator,
        "      commit: ${{ needs.bind-release.outputs.commit }}",
        "      commit: ${{ needs.bind-release.outputs.tooling_commit }}",
      ),
      replaceRequired(
        source.coordinator,
        "      desktop_version: ${{ needs.bind-release.outputs.desktop_version }}",
        "      npm_version: forbidden\n      desktop_version: ${{ needs.bind-release.outputs.desktop_version }}",
      ),
      replaceRequired(
        source.coordinator,
        "    uses: ./.github/workflows/desktop-release.yml\n    with:",
        "    uses: ./.github/workflows/desktop-release.yml\n    secrets: inherit\n    with:",
      ),
    ];
    for (const coordinator of mutations) {
      expectIssue({ ...source, coordinator }, "secretless npm-independent reusable workflow tuple");
    }
  });

  it("holds stable concurrency and least privilege on the reusable call job", () => {
    const source = sources();
    const excessivePermissions = replaceRequired(
      source.coordinator,
      "  desktop-release:\n    needs: [bind-release, prepare-release-draft]\n    concurrency:\n      group: stable-desktop\n      cancel-in-progress: false\n      queue: max\n    permissions:\n      actions: read\n      contents: write",
      "  desktop-release:\n    needs: [bind-release, prepare-release-draft]\n    concurrency:\n      group: stable-desktop\n      cancel-in-progress: false\n      queue: max\n    permissions:\n      actions: write\n      contents: write",
    );
    expectIssue(
      { ...source, coordinator: excessivePermissions },
      "permissions are not least-privilege",
    );

    const cancelling = replaceRequired(
      source.coordinator,
      "      cancel-in-progress: false\n      queue: max",
      "      cancel-in-progress: true\n      queue: max",
    );
    expectIssue({ ...source, coordinator: cancelling }, "stable-desktop concurrency");
  });

  it("requires the child to accept only desktop release inputs", () => {
    const source = sources();
    const desktop = replaceRequired(
      source.desktop,
      "      desktop_version:\n",
      "      npm_version:\n        description: Forbidden npm identity\n        required: true\n        type: string\n      desktop_version:\n",
    );
    expectIssue({ ...source, desktop }, "only the frozen desktop release tuple");
    expectIssue({ ...source, desktop }, "must not consume npm release identity");
  });

  it("keeps the desktop workflow reusable-call-only", () => {
    const source = sources();
    const desktop = replaceRequired(source.desktop, "  workflow_call:", "  workflow_dispatch:");
    expectIssue({ ...source, desktop }, "workflow_call-only");
  });

  it("requires the child source run id in the frozen reusable tuple", () => {
    const source = sources();
    const desktop = replaceRequired(
      source.desktop,
      "      source_run_id:\n        description: Failed source run id or none\n        required: true\n        type: string\n",
      "",
    );
    expectIssue({ ...source, desktop }, "only the frozen desktop release tuple");
    expectIssue({ ...source, desktop }, "workflow_call must require string input source_run_id");
  });

  it("rejects obsolete cross-run dispatch binding machinery", () => {
    const source = sources();
    const mutations = [
      replaceRequired(
        source.desktop,
        "      source_run_id:\n",
        "      dispatch_nonce:\n        description: Obsolete nonce\n        required: true\n        type: string\n      source_run_id:\n",
      ),
      replaceRequired(
        source.desktop,
        "          set -euo pipefail\n          printf '%s' \"$CURRENT_RUN_ID\"",
        "          set -euo pipefail\n          COORDINATOR_ARTIFACTS=desktop-dispatch-binding\n          printf '%s' \"$CURRENT_RUN_ID\"",
      ),
    ];
    for (const [index, desktop] of mutations.entries()) {
      expect(
        inspect({ ...source, desktop }).some((issue) =>
          issue.includes("must not retain obsolete dispatch binding machinery"),
        ),
        `obsolete dispatch mutation ${index}`,
      ).toBe(true);
    }
  });

  it("authorizes exact caller and called workflow identities in the same run", () => {
    const source = sources();
    const mutations = [
      replaceRequired(
        source.desktop,
        "          CALLER_WORKFLOW_REF: ${{ github.workflow_ref }}",
        "          CALLER_WORKFLOW_REF: ${{ github.ref }}",
      ),
      replaceRequired(
        source.desktop,
        "          CALLED_WORKFLOW_REF: ${{ job.workflow_ref }}",
        "          CALLED_WORKFLOW_REF: ${{ github.workflow_ref }}",
      ),
      replaceRequired(
        source.desktop,
        'test "$CALLER_WORKFLOW_REF" = "$GITHUB_REPOSITORY/.github/workflows/desktop-release-coordinator.yml@$WORKFLOW_REF"',
        'test "$CALLER_WORKFLOW_REF" = "$GITHUB_REPOSITORY/.github/workflows/release.yml@$WORKFLOW_REF"',
      ),
      replaceRequired(source.desktop, 'test "$CALLER_WORKFLOW_SHA" = "$WORKFLOW_COMMIT"', "true"),
      replaceRequired(
        source.desktop,
        'test "$CALLED_WORKFLOW_REF" = "$GITHUB_REPOSITORY/.github/workflows/desktop-release.yml@$WORKFLOW_REF"',
        'test "$CALLED_WORKFLOW_REF" = "$GITHUB_REPOSITORY/.github/workflows/release.yml@$WORKFLOW_REF"',
      ),
      replaceRequired(source.desktop, 'test "$CALLED_WORKFLOW_SHA" = "$WORKFLOW_COMMIT"', "true"),
      replaceRequired(
        source.desktop,
        "          REPOSITORY_ID: ${{ github.repository_id }}",
        "          REPOSITORY_ID: ${{ github.repository }}",
      ),
    ];
    for (const desktop of mutations) {
      expectIssue({ ...source, desktop }, "same-run active coordinator and called workflow");
    }
  });

  it("binds child authorization to the normal or recovery workflow ref", () => {
    const source = sources();
    const mutations = [
      replaceRequired(
        source.desktop,
        "          RELEASE_TAG: ${{ inputs.tag }}",
        "          RELEASE_TAG: ${{ inputs.tooling_commit }}",
      ),
      replaceRequired(
        source.desktop,
        'test "$WORKFLOW_REF_NAME" = "$RELEASE_TAG"',
        'test "$WORKFLOW_REF_NAME" = "$RELEASE_TAG-recovery.1"',
      ),
      replaceRequired(
        source.desktop,
        'test "$WORKFLOW_REF_NAME" = "${RELEASE_TAG}-recovery.${CURRENT_RECOVERY_REVISION}"',
        'test "$WORKFLOW_REF_NAME" = "${RELEASE_TAG}-recovery.1"',
      ),
    ];
    for (const desktop of mutations) {
      expectIssue({ ...source, desktop }, "same-run active coordinator and called workflow");
    }
  });

  it("independently revalidates source run, attempt jobs, and artifact provenance", () => {
    const source = sources();
    const mutations = [
      replaceRequired(source.desktop, ".head_repository.full_name", ".repository.full_name"),
      replaceRequired(
        source.desktop,
        "actions/runs/$SOURCE_RUN_ID/attempts/$SOURCE_RUN_ATTEMPT/jobs?per_page=100",
        "actions/runs/$SOURCE_RUN_ID/jobs?per_page=100",
      ),
      replaceRequired(
        source.desktop,
        "([.[].jobs[]] | length) == .[0].total_count",
        "([.[].jobs[]] | length) > 0",
      ),
      source.desktop.replaceAll(".workflow_run.head_repository_id", ".workflow_run.repository_id"),
    ];
    for (const desktop of mutations) {
      expectIssue(
        { ...source, desktop },
        "child must independently validate source run, job, and artifact provenance",
      );
    }
  });

  it("allows only legacy-bot or reusable-coordinator source provenance in the authorizer", () => {
    const source = sources();
    const mutations = [
      replaceRequired(
        source.desktop,
        'SOURCE_WORKFLOW_PATH="${SOURCE_WORKFLOW_PATH_RAW%%@*}"',
        'SOURCE_WORKFLOW_PATH="$SOURCE_WORKFLOW_PATH_RAW"',
      ),
      replaceRequired(
        source.desktop,
        "            .github/workflows/desktop-release.yml)",
        "            .github/workflows/release.yml)",
      ),
      replaceRequired(
        source.desktop,
        "            .github/workflows/desktop-release-coordinator.yml)\n              ;;",
        "            .github/workflows/desktop-release-coordinator.yml)\n              ;;\n            .github/workflows/release.yml)\n              ;;",
      ),
      replaceRequired(
        source.desktop,
        "              test \"$(printf '%s' \"$SOURCE\" | jq -r '.actor.login')\" = 'github-actions[bot]'",
        "              true",
      ),
      replaceRequired(
        source.desktop,
        "              test \"$(printf '%s' \"$SOURCE\" | jq -r '.triggering_actor.login')\" = 'github-actions[bot]'",
        "              true",
      ),
      replaceRequired(
        source.desktop,
        "            .github/workflows/desktop-release-coordinator.yml)\n              ;;",
        "            .github/workflows/desktop-release-coordinator.yml)\n              test \"$(printf '%s' \"$SOURCE\" | jq -r '.actor.login')\" = 'github-actions[bot]'\n              ;;",
      ),
      replaceRequired(
        source.desktop,
        '"$SOURCE_WORKFLOW_PATH"|"$SOURCE_WORKFLOW_PATH@$SOURCE_HEAD_BRANCH"|"$SOURCE_WORKFLOW_PATH@refs/tags/$SOURCE_HEAD_BRANCH")',
        '"$SOURCE_WORKFLOW_PATH"*)',
      ),
      replaceRequired(
        source.desktop,
        "          test \"$(printf '%s' \"$SOURCE\" | jq -r '.event')\" = 'workflow_dispatch'",
        "          true",
      ),
      replaceRequired(
        source.desktop,
        '          test "$(printf \'%s\' "$SOURCE" | jq -r \'.repository.full_name\')" = "$GITHUB_REPOSITORY"',
        "          true",
      ),
    ];
    for (const desktop of mutations) {
      expectIssue(
        { ...source, desktop },
        "child must independently validate source run, job, and artifact provenance",
      );
    }
  });

  it("accepts only the candidate or an earlier recovery source in the authorizer", () => {
    const source = sources();
    const mutations = [
      replaceRequired(source.desktop, 'test "$SOURCE_HEAD_SHA" = "$RELEASE_COMMIT"', "true"),
      replaceRequired(
        source.desktop,
        "printf '%s' \"$SOURCE_RECOVERY_REVISION\" | grep -Eq '^[1-9][0-9]*$'",
        "printf '%s' \"$SOURCE_RECOVERY_REVISION\" | grep -Eq '^[0-9]+$'",
      ),
      replaceRequired(
        source.desktop,
        'test "$SOURCE_HEAD_BRANCH" = "${RELEASE_TAG}-recovery.${SOURCE_RECOVERY_REVISION}"',
        "true",
      ),
      replaceRequired(
        source.desktop,
        'test "$SOURCE_RECOVERY_REVISION" -lt "$CURRENT_RECOVERY_REVISION"',
        'test "$SOURCE_RECOVERY_REVISION" != "$CURRENT_RECOVERY_REVISION"',
      ),
      replaceRequired(
        source.desktop,
        'test "$SOURCE_RECOVERY_REVISION" -lt "$CURRENT_RECOVERY_REVISION"',
        'test "$SOURCE_RECOVERY_REVISION" -le "$CURRENT_RECOVERY_REVISION"',
      ),
      replaceRequired(
        source.desktop,
        'test "$(git rev-parse "refs/tags/$SOURCE_HEAD_BRANCH^{commit}")" = "$SOURCE_HEAD_SHA"',
        "true",
      ),
      replaceRequired(
        source.desktop,
        'git merge-base --is-ancestor "$RELEASE_COMMIT" "$SOURCE_HEAD_SHA"',
        'git merge-base --is-ancestor "$SOURCE_HEAD_SHA" "$RELEASE_COMMIT"',
      ),
      replaceRequired(
        source.desktop,
        'git merge-base --is-ancestor "$SOURCE_HEAD_SHA" "$RELEASE_TOOLING_COMMIT"',
        'git merge-base --is-ancestor "$RELEASE_TOOLING_COMMIT" "$SOURCE_HEAD_SHA"',
      ),
      replaceRequired(
        source.desktop,
        'git merge-base --is-ancestor "$SOURCE_HEAD_SHA" refs/remotes/origin/main',
        'git merge-base --is-ancestor "$RELEASE_COMMIT" refs/remotes/origin/main',
      ),
    ];
    for (const desktop of mutations) {
      expectIssue(
        { ...source, desktop },
        "child must independently validate source run, job, and artifact provenance",
      );
    }
  });

  it("requires exact terminal source jobs and a non-successful activation in the authorizer", () => {
    const source = sources();
    const mutations = [
      replaceRequired(
        source.desktop,
        '[.[].jobs[] | select((.name | split(" / ") | last) == $job)] as $matches |',
        "[.[].jobs[] | select(.name | contains($job))] as $matches |",
      ),
      replaceRequired(
        source.desktop,
        "              ($matches | length) == 1 and",
        "              ($matches | length) > 0 and",
      ),
      replaceRequired(
        source.desktop,
        '[.[].jobs[] | select((.name | split(" / ") | last) == "activate-release")] as $matches |',
        '[.[].jobs[] | select(.name | contains("activate-release"))] as $matches |',
      ),
      replaceRequired(
        source.desktop,
        '[.[].jobs[] | select((.name | split(" / ") | last) == "activate-release")] as $matches |\n            ($matches | length) == 1 and',
        '[.[].jobs[] | select((.name | split(" / ") | last) == "activate-release")] as $matches |\n            ($matches | length) > 0 and',
      ),
      replaceRequired(
        source.desktop,
        '$matches[0].conclusion != "success"',
        '$matches[0].conclusion == "failure"',
      ),
    ];
    for (const desktop of mutations) {
      expectIssue(
        { ...source, desktop },
        "child must independently validate source run, job, and artifact provenance",
      );
    }
  });

  it("keeps candidate release reads out of the read-only authorizer", () => {
    const source = sources();
    const desktop = replaceRequired(
      source.desktop,
      "          set -euo pipefail\n          printf '%s' \"$CURRENT_RUN_ID\"",
      '          set -euo pipefail\n          CANDIDATE_RELEASE=$(gh api "repos/$GITHUB_REPOSITORY/releases/$RELEASE_DRAFT_ID")\n          printf \'%s\' "$CURRENT_RUN_ID"',
    );
    expectIssue(
      { ...source, desktop },
      "same-run active coordinator and called workflow identities",
    );
  });

  it("revalidates recoverable candidate state at the protected staging boundary", () => {
    const source = sources();
    const mutations = [
      replaceRequired(
        source.desktop,
        "      - name: Revalidate recoverable candidate state\n        env:\n          GH_TOKEN: ${{ github.token }}",
        '      - name: Revalidate recoverable candidate state\n        env:\n          GH_TOKEN: ""',
      ),
      replaceRequired(
        source.desktop,
        "          fi\n      - name: Upload updater envelope to the private draft",
        "          fi\n      - run: echo delayed\n      - name: Upload updater envelope to the private draft",
      ),
      replaceRequired(
        source.desktop,
        'test "$(printf \'%s\' "$CANDIDATE_RELEASE" | jq -r \'.id | tostring\')" = "$RELEASE_DRAFT_ID"',
        "true",
      ),
      replaceRequired(
        source.desktop,
        "            test \"$SOURCE_RUN_ID\" != 'none'",
        "            true",
      ),
      replaceRequired(
        source.desktop,
        "Desktop update validation is in progress. This release is not yet generally available.",
        "A public body that is not the exact provisional sentinel.",
      ),
      replaceRequired(
        source.desktop,
        'test "$CANDIDATE_BODY_SHA256" = "$RELEASE_BODY_SHA256"',
        "true",
      ),
      replaceRequired(
        source.desktop,
        "gh api -H 'Cache-Control: no-cache' \"repos/$GITHUB_REPOSITORY/releases/latest\"",
        'gh api "repos/$GITHUB_REPOSITORY/releases/latest"',
      ),
      replaceRequired(
        source.desktop,
        'test "$(printf \'%s\' "$LATEST_RELEASE" | jq -r \'.id | tostring\')" = "$RELEASE_DRAFT_ID"',
        "true",
      ),
      replaceRequired(
        source.desktop,
        'test "$(printf \'%s\' "$LATEST_RELEASE" | jq -r \'.tag_name\')" = "$RELEASE_TAG"',
        "true",
      ),
    ];
    for (const [index, desktop] of mutations.entries()) {
      expect(
        inspect({ ...source, desktop }).some((issue) =>
          issue.includes("protected private-draft safeguard must revalidate candidate state"),
        ),
        `private-draft safeguard mutation ${index}`,
      ).toBe(true);
    }
  });

  it("keeps the npm workflow unable to trigger or parse desktop releases", () => {
    const source = sources();
    const desktopTrigger = replaceRequired(
      source.release,
      "      - 'duathlon-coach@*'",
      "      - 'duathlon-coach@*'\n      - 'enduragent-desktop@*'",
    );
    expectIssue({ ...source, release: desktopTrigger }, "must not authorize desktop candidates");

    const enabledLegacy = replaceRequired(source.release, "if: ${{ false }}", "if: ${{ true }}");
    expectIssue({ ...source, release: enabledLegacy }, "must remain literally disabled");
  });

  it("keeps npm GitHub releases non-latest and non-destructive", () => {
    const source = sources();
    const release = replaceRequired(
      source.release,
      'gh release create "$TAG" --latest=false --title',
      'gh release create "$TAG" --title',
    );
    expectIssue({ ...source, release }, "npm GitHub releases must be verified, non-latest");
  });

  it("skips unchanged public package versions before tagging", () => {
    const source = sources();
    const version = replaceRequired(
      source.version,
      'if [ "$VERSION" = "$PREVIOUS_VERSION" ]; then',
      'if [ "$VERSION" != "$PREVIOUS_VERSION" ]; then',
    );
    expectIssue({ ...source, version }, "skip unchanged npm versions");
  });

  it("independently tags and dispatches changed desktop versions on the exact tag", () => {
    const source = sources();
    const mutations = [
      replaceRequired(
        source.version,
        'DESKTOP_TAG="enduragent-desktop@$DESKTOP_VERSION"',
        'DESKTOP_TAG="cycling-coach@$DESKTOP_VERSION"',
      ),
      replaceRequired(
        source.version,
        'gh workflow run desktop-release-coordinator.yml --ref "$DESKTOP_TAG"',
        "gh workflow run desktop-release-coordinator.yml --ref main",
      ),
      replaceRequired(
        source.version,
        "gh workflow run desktop-release-coordinator.yml",
        "gh workflow run desktop-release.yml",
      ),
    ];
    for (const version of mutations) {
      expectIssue({ ...source, version }, "independently tag and dispatch changed desktop SemVer");
    }
  });

  it("rejects pnpm separators that become transaction arguments", () => {
    const source = sources();
    const desktop = replaceRequired(
      source.desktop,
      "desktop-release:transaction baseline",
      "desktop-release:transaction -- baseline",
    );
    expectIssue({ ...source, desktop }, "pnpm argument separator");
  });

  it("keeps signing permission and secrets exclusive", () => {
    const source = sources();
    const githubTokenBinding = ["GITHUB_TOKEN", "${{ github.token }}"].join(": ");
    const desktop = replaceRequired(
      source.desktop,
      "  sign-macos:\n    runs-on: macos-15\n    needs: authorize-coordinator\n    environment: desktop-macos-signing\n    permissions:\n      actions: read\n      contents: read",
      "  sign-macos:\n    runs-on: macos-15\n    needs: authorize-coordinator\n    environment: desktop-macos-signing\n    permissions:\n      actions: read\n      contents: write",
    ).replaceAll(githubTokenBinding, "CSC_LINK: ${{ secrets.CSC_LINK }}");
    expectIssue({ ...source, desktop }, "macOS signing permissions");
    expectIssue({ ...source, desktop }, "escaped the signing job");
  });

  it("requires workspace dependencies and signing environment secrets before packaging", () => {
    const source = sources();
    const noBuild = replaceRequired(
      source.desktop,
      "      - if: ${{ inputs.source_run_id == 'none' }}\n        run: pnpm -r build\n",
      "",
    );
    expectIssue({ ...source, desktop: noBuild }, "build workspace dependencies before packaging");
    const unchecked = replaceRequired(
      source.desktop,
      "for secret_name in CSC_LINK CSC_KEY_PASSWORD APPLE_API_KEY_ID APPLE_API_ISSUER APPLE_API_KEY_P8_BASE64; do",
      "for secret_name in CSC_LINK; do",
    );
    expectIssue({ ...source, desktop: unchecked }, "fail closed when an environment secret");
  });

  it("makes every signing-production step fresh-only during resume", () => {
    const source = sources();
    const mutations = [
      replaceRequired(
        source.desktop,
        "      - if: ${{ inputs.source_run_id == 'none' }}\n        run: pnpm -r build",
        "      - run: pnpm -r build",
      ),
      replaceRequired(
        source.desktop,
        "      - name: Resolve signed baseline\n        if: ${{ inputs.source_run_id == 'none' }}",
        "      - name: Resolve signed baseline\n        if: ${{ always() }}",
      ),
      replaceRequired(
        source.desktop,
        "      - name: Build signed and notarized macOS envelope\n        if: ${{ inputs.source_run_id == 'none' }}",
        "      - name: Build signed and notarized macOS envelope\n        if: ${{ always() }}",
      ),
      replaceRequired(
        source.desktop,
        "      - name: Bind candidate signing evidence\n        if: ${{ inputs.source_run_id == 'none' }}",
        "      - name: Bind candidate signing evidence\n        if: ${{ always() }}",
      ),
      replaceRequired(
        source.desktop,
        "      - name: Seal digest-bound release manifest\n        if: ${{ inputs.source_run_id == 'none' }}",
        "      - name: Seal digest-bound release manifest\n        if: ${{ always() }}",
      ),
      replaceRequired(
        source.desktop,
        "      - name: Upload sealed macOS transaction artifact\n        if: ${{ inputs.source_run_id == 'none' }}",
        "      - name: Upload sealed macOS transaction artifact\n        if: ${{ always() }}",
      ),
      replaceRequired(
        source.desktop,
        "      - name: Upload sealed baseline updater envelope\n        if: ${{ inputs.source_run_id == 'none' && inputs.mode == 'steady' }}",
        "      - name: Upload sealed baseline updater envelope\n        if: ${{ inputs.mode == 'steady' }}",
      ),
    ];
    for (const desktop of mutations) {
      expectIssue(
        { ...source, desktop },
        "resume must skip build, signing, notarization, sealing, and signing-artifact upload",
      );
    }
  });

  it("reuses only the authorized source run's digest-bound artifacts", () => {
    const source = sources();
    const mutations = [
      replaceRequired(
        source.desktop,
        "run-id: ${{ needs.authorize-coordinator.outputs.source_run_id }}",
        "run-id: ${{ github.run_id }}",
      ),
      replaceRequired(
        source.desktop,
        "artifact-ids: ${{ needs.authorize-coordinator.outputs.baseline_artifact_id }}",
        "artifact-ids: ${{ needs.authorize-coordinator.outputs.artifact_id }}",
      ),
      replaceRequired(
        source.desktop,
        "          digest-mismatch: error",
        "          digest-mismatch: warn",
      ),
      replaceRequired(
        source.desktop,
        'test "$(jq -er \'.workflowRunId\' "$MANIFEST")" = "$SOURCE_RUN_ID"',
        "true",
      ),
    ];
    for (const desktop of mutations) {
      expectIssue(
        { ...source, desktop },
        "resume must reuse exact digest-bound artifacts from the authorized run",
      );
    }
  });

  it("normalizes fresh and resumed signing evidence before downstream use", () => {
    const source = sources();
    const mutations = [
      replaceRequired(
        source.desktop,
        "evidence_run_id: ${{ steps.normalized-evidence.outputs.evidence_run_id }}",
        "evidence_run_id: ${{ github.run_id }}",
      ),
      replaceRequired(
        source.desktop,
        'EVIDENCE_RUN_ID="$SOURCE_RUN_ID"',
        'EVIDENCE_RUN_ID="$GITHUB_RUN_ID"',
      ),
    ];
    for (const desktop of mutations) {
      expectIssue({ ...source, desktop }, "normalize fresh and resumed immutable evidence");
    }
  });

  it("uses normalized manifest baseline evidence for resumed consumers", () => {
    const source = sources();
    const rawBaseline = replaceRequired(
      source.desktop,
      "RELEASE_BASELINE_TAG: ${{ needs.sign-macos.outputs.baseline_tag }}",
      "RELEASE_BASELINE_TAG: ${{ inputs.baseline_tag }}",
    );
    expectIssue({ ...source, desktop: rawBaseline }, "normalized manifest evidence");

    const uncheckedMetadata = replaceRequired(
      source.desktop,
      'test "$INDEPENDENT_METADATA_SHA256" = "$SIGNED_METADATA_SHA256"',
      "true",
    );
    expectIssue({ ...source, desktop: uncheckedMetadata }, "normalized manifest evidence");
  });

  it("uses normalized evidence run ids and digest checks on every downstream download", () => {
    const source = sources();
    const wrongRun = source.desktop.replaceAll(
      "run-id: ${{ needs.sign-macos.outputs.evidence_run_id }}",
      "run-id: ${{ github.run_id }}",
    );
    expectIssue({ ...source, desktop: wrongRun }, "normalized digest-bound cross-run evidence");

    const missingDigest = replaceRequired(
      source.desktop,
      "          run-id: ${{ needs.sign-macos.outputs.evidence_run_id }}\n          digest-mismatch: error",
      "          run-id: ${{ needs.sign-macos.outputs.evidence_run_id }}",
    );
    expectIssue(
      { ...source, desktop: missingDigest },
      "normalized digest-bound cross-run evidence",
    );
  });

  it("requires protected publication, latest, and compensation environments", () => {
    const source = sources();
    const desktop = replaceRequired(
      source.desktop,
      "environment: desktop-macos-latest",
      "environment: desktop-macos-publication",
    );
    expectIssue(
      { ...source, desktop },
      "write-authority desktop jobs must use protected environments",
    );
  });

  it("requires exact asset staging, metadata-last publication, and latest CAS", () => {
    const source = sources();
    const noStage = replaceRequired(
      source.desktop,
      "desktop-release:transaction stage",
      "desktop-release:transaction verify",
    );
    expectIssue({ ...source, desktop: noStage }, "stage exact assets");
    const noObservation = replaceRequired(
      source.desktop,
      "desktop-release:transaction observe",
      "desktop-release:transaction verify",
    );
    expectIssue({ ...source, desktop: noObservation }, "bind latest before metadata-last");
    const noCas = replaceRequired(
      source.desktop,
      "desktop-release:transaction promote",
      "desktop-release:transaction publish",
    );
    expectIssue({ ...source, desktop: noCas }, "compare-and-swap");
  });

  it("separates latest mutation from read-only reconciliation", () => {
    const source = sources();
    const mutations = [
      replaceRequired(
        source.desktop,
        "needs: [sign-macos, publish-assets, request-latest]",
        "needs: [sign-macos, publish-assets]",
      ),
      replaceRequired(
        source.desktop,
        "  reconcile-latest:\n    runs-on: ubuntu-latest\n    needs: [sign-macos, publish-assets, request-latest]\n    environment: desktop-macos-latest\n    permissions:\n      actions: read\n      contents: read",
        "  reconcile-latest:\n    runs-on: ubuntu-latest\n    needs: [sign-macos, publish-assets, request-latest]\n    environment: desktop-macos-latest\n    permissions:\n      actions: read\n      contents: write",
      ),
      replaceRequired(
        source.desktop,
        "desktop-release:transaction reconcile --directory",
        "desktop-release:transaction promote --directory",
      ),
    ];
    for (const desktop of mutations) {
      expectIssue(
        { ...source, desktop },
        "latest request must compare-and-swap before read-only latest reconciliation",
      );
    }
  });

  it("requires the native production-feed round trip and gated activation", () => {
    const source = sources();
    const missingTimeout = replaceRequired(
      source.desktop,
      "  verify-production-update:\n    runs-on: macos-15\n    timeout-minutes: 30",
      "  verify-production-update:\n    runs-on: macos-15",
    );
    expectIssue({ ...source, desktop: missingTimeout }, "production-feed N-to-N+1 round trip");
    const wrongTimeout = replaceRequired(
      source.desktop,
      "  verify-production-update:\n    runs-on: macos-15\n    timeout-minutes: 30",
      "  verify-production-update:\n    runs-on: macos-15\n    timeout-minutes: 31",
    );
    expectIssue({ ...source, desktop: wrongTimeout }, "production-feed N-to-N+1 round trip");
    const noRoundTrip = replaceRequired(
      source.desktop,
      "test:macos-update-roundtrip",
      "test:disabled-roundtrip",
    );
    expectIssue({ ...source, desktop: noRoundTrip }, "production-feed N-to-N+1 round trip");
    const missingDependencyBuild = replaceRequired(
      source.desktop,
      "pnpm --filter '@enduragent/desktop^...' build",
      "pnpm --filter '@enduragent/desktop^...' check",
    );
    expectIssue(
      { ...source, desktop: missingDependencyBuild },
      "production-feed N-to-N+1 round trip",
    );
    const dependencyBuildBeforeInstall = replaceRequired(
      source.desktop,
      "      - run: pnpm install --frozen-lockfile\n      - name: Build updater acceptance dependencies\n        run: pnpm --filter '@enduragent/desktop^...' build",
      "      - name: Build updater acceptance dependencies\n        run: pnpm --filter '@enduragent/desktop^...' build\n      - run: pnpm install --frozen-lockfile",
    );
    expectIssue(
      { ...source, desktop: dependencyBuildBeforeInstall },
      "production-feed N-to-N+1 round trip",
    );
    const freshOnlyDependencyBuild = replaceRequired(
      source.desktop,
      "      - name: Build updater acceptance dependencies\n        run: pnpm --filter '@enduragent/desktop^...' build",
      "      - name: Build updater acceptance dependencies\n        if: ${{ inputs.source_run_id == 'none' }}\n        run: pnpm --filter '@enduragent/desktop^...' build",
    );
    expectIssue(
      { ...source, desktop: freshOnlyDependencyBuild },
      "production-feed N-to-N+1 round trip",
    );
    const duplicateDependencyBuild = replaceRequired(
      source.desktop,
      "      - name: Build updater acceptance dependencies\n        run: pnpm --filter '@enduragent/desktop^...' build",
      "      - name: Build updater acceptance dependencies\n        run: pnpm --filter '@enduragent/desktop^...' build\n      - name: Duplicate updater acceptance dependency build\n        run: pnpm --filter '@enduragent/desktop^...' build",
    );
    expectIssue(
      { ...source, desktop: duplicateDependencyBuild },
      "production-feed N-to-N+1 round trip",
    );
    const updaterCommandBlock =
      '          pnpm --filter @enduragent/desktop test:macos-update-roundtrip \\\n            "$BASELINE_VERSION" \\\n            "$CANDIDATE_VERSION" \\\n            "$RUNNER_TEMP/desktop-baseline" \\\n            "$CANDIDATE_ENVELOPE" \\\n            "$EVIDENCE"';
    const updaterRemovedFromExercise = replaceRequired(
      source.desktop,
      updaterCommandBlock,
      "          echo 'updater command moved before dependency build'",
    );
    const updaterBeforeDependencyBuild = replaceRequired(
      updaterRemovedFromExercise,
      "      - name: Build updater acceptance dependencies\n        run: pnpm --filter '@enduragent/desktop^...' build",
      `      - name: Run updater command too early
        run: |
${updaterCommandBlock}
      - name: Build updater acceptance dependencies
        run: pnpm --filter '@enduragent/desktop^...' build`,
    );
    expectIssue(
      { ...source, desktop: updaterBeforeDependencyBuild },
      "production-feed N-to-N+1 round trip",
    );
    const bypass = replaceRequired(
      source.desktop,
      "needs.verify-production-update.result == 'success'",
      "needs.verify-production-update.result != 'failure'",
    );
    expectIssue({ ...source, desktop: bypass }, "mode-specific acceptance");

    const bypassReconciliation = replaceRequired(
      source.desktop,
      "needs: [sign-macos, reconcile-latest]",
      "needs: [sign-macos, request-latest]",
    );
    expectIssue(
      { ...source, desktop: bypassReconciliation },
      "production-feed N-to-N+1 round trip",
    );
  });

  it("requires compensation to restore prior latest and withdraw the candidate", () => {
    const source = sources();
    const desktop = replaceRequired(
      source.desktop,
      "needs.activate-release.result != 'success'",
      "needs.activate-release.result == 'failure'",
    );
    expectIssue({ ...source, desktop }, "successful reconciliation");

    const beforeReconciliation = replaceRequired(
      source.desktop,
      "needs.reconcile-latest.result == 'success' &&\n          needs.activate-release.result != 'success'",
      "needs.request-latest.result == 'success' &&\n          needs.activate-release.result != 'success'",
    );
    expectIssue({ ...source, desktop: beforeReconciliation }, "successful reconciliation");
  });

  it("keeps compensation rollback bound to normalized manifest baseline evidence", () => {
    const source = sources();
    const mutations = [
      replaceRequired(
        source.desktop,
        "BASELINE_METADATA_SHA256: ${{ needs.sign-macos.outputs.baseline_metadata_sha256 }}",
        "BASELINE_METADATA_SHA256: ${{ steps.observe.outputs.latest_metadata_sha256 }}",
      ),
      replaceRequired(
        source.desktop,
        "EXPECTED_LATEST_TAG: ${{ needs.publish-assets.outputs.rollback_latest_tag }}",
        "EXPECTED_LATEST_TAG: ${{ needs.publish-assets.outputs.latest_tag }}",
      ),
      replaceRequired(
        source.desktop,
        "rollback_latest_metadata_sha256: ${{ steps.observe.outputs.rollback_latest_metadata_sha256 }}",
        "rollback_latest_metadata_sha256: ${{ steps.observe.outputs.latest_metadata_sha256 }}",
      ),
    ];
    for (const desktop of mutations) {
      expectIssue({ ...source, desktop }, "normalized manifest baseline evidence");
    }
  });

  it("binds recovery tooling to the coordinator and audited overlay", () => {
    const source = sources();
    const unbound = replaceRequired(
      source.desktop,
      'test "$RELEASE_TOOLING_COMMIT" = "$WORKFLOW_COMMIT"',
      "true",
    );
    expectIssue({ ...source, desktop: unbound }, "same-run active coordinator");
    const productOverlay = replaceRequired(
      source.desktop,
      "            apps/desktop/scripts/macos-release-cli.mjs \\\n",
      "            apps/desktop/src/main/index.ts\n",
    );
    expectIssue({ ...source, desktop: productOverlay }, "manual signing recovery must overlay");
    const reversedAncestry = replaceRequired(
      source.desktop,
      'git merge-base --is-ancestor "$RELEASE_COMMIT" "$RELEASE_TOOLING_COMMIT"',
      'git merge-base --is-ancestor "$RELEASE_TOOLING_COMMIT" "$RELEASE_COMMIT"',
    );
    expectIssue({ ...source, desktop: reversedAncestry }, "manual signing recovery must overlay");
    const unstagedRestore = replaceRequired(source.desktop, "--staged --worktree", "--worktree");
    expectIssue({ ...source, desktop: unstagedRestore }, "must overlay exactly");
    const unstagedOverlay = replaceRequired(
      source.desktop,
      "git diff --cached --name-only",
      "git diff --name-only",
    );
    expectIssue({ ...source, desktop: unstagedOverlay }, "must overlay exactly");
    const allowsTrackedDrift = replaceRequired(
      source.desktop,
      'test -z "$(git diff --name-only)"',
      "true",
    );
    expectIssue({ ...source, desktop: allowsTrackedDrift }, "must overlay exactly");
    const allowsUntrackedDrift = replaceRequired(
      source.desktop,
      'test -z "$(git ls-files --others --exclude-standard)"',
      "true",
    );
    expectIssue({ ...source, desktop: allowsUntrackedDrift }, "must overlay exactly");
    const movesCandidateHead = replaceRequired(
      source.desktop,
      '          test -z "$(git ls-files --others --exclude-standard)"\n          test "$(git rev-parse HEAD)" = "$RELEASE_COMMIT"',
      '          test -z "$(git ls-files --others --exclude-standard)"',
    );
    expectIssue({ ...source, desktop: movesCandidateHead }, "must overlay exactly");
  });

  it("keeps non-updater downstream recovery jobs transaction-only", () => {
    const source = sources();
    const expandedOverlay = replaceRequired(
      source.desktop,
      "          test \"$(git diff --cached --name-only)\" = 'tools/desktop-release-transaction.ts'",
      "          test \"$(git diff --cached --name-only)\" = $'apps/desktop/scripts/macos-release-cli.mjs\\ntools/desktop-release-transaction.ts'",
    );
    expectIssue(
      { ...source, desktop: expandedOverlay },
      "verify-macos-envelope recovery must overlay exactly tools/desktop-release-transaction.ts",
    );

    const missingTransaction = replaceRequired(
      source.desktop,
      "            tools/desktop-release-transaction.ts\n          test \"$(git diff --cached --name-only)\" = 'tools/desktop-release-transaction.ts'",
      "            apps/desktop/scripts/macos-release-cli.mjs\n          test \"$(git diff --cached --name-only)\" = 'apps/desktop/scripts/macos-release-cli.mjs'",
    );
    expectIssue(
      { ...source, desktop: missingTransaction },
      "verify-macos-envelope recovery must overlay exactly tools/desktop-release-transaction.ts",
    );
  });

  it("binds updater recovery to the exact ordered acceptance-tooling overlay", () => {
    const source = sources();
    const updaterOverlay = [
      '          git restore --source="$RELEASE_TOOLING_COMMIT" --staged --worktree -- \\',
      "            apps/desktop/scripts/verify-updater-round-trip.mjs \\",
      "            tools/desktop-release-transaction.ts",
      "          EXPECTED_RECOVERY_DIFF=$'apps/desktop/scripts/verify-updater-round-trip.mjs\\ntools/desktop-release-transaction.ts'",
      '          test "$(git diff --cached --name-only)" = "$EXPECTED_RECOVERY_DIFF"',
    ].join("\n");
    const mutations = [
      [
        '          git restore --source="$RELEASE_TOOLING_COMMIT" --staged --worktree -- \\',
        "            tools/desktop-release-transaction.ts",
        "          test \"$(git diff --cached --name-only)\" = 'tools/desktop-release-transaction.ts'",
      ].join("\n"),
      [
        '          git restore --source="$RELEASE_TOOLING_COMMIT" --staged --worktree -- \\',
        "            apps/desktop/scripts/verify-updater-round-trip.mjs",
        "          test \"$(git diff --cached --name-only)\" = 'apps/desktop/scripts/verify-updater-round-trip.mjs'",
      ].join("\n"),
      [
        '          git restore --source="$RELEASE_TOOLING_COMMIT" --staged --worktree -- \\',
        "            apps/desktop/scripts/verify-updater-round-trip.mjs \\",
        "            apps/desktop/src/main/index.ts \\",
        "            tools/desktop-release-transaction.ts",
        "          EXPECTED_RECOVERY_DIFF=$'apps/desktop/scripts/verify-updater-round-trip.mjs\\napps/desktop/src/main/index.ts\\ntools/desktop-release-transaction.ts'",
        '          test "$(git diff --cached --name-only)" = "$EXPECTED_RECOVERY_DIFF"',
      ].join("\n"),
      [
        '          git restore --source="$RELEASE_TOOLING_COMMIT" --staged --worktree -- \\',
        "            tools/desktop-release-transaction.ts \\",
        "            apps/desktop/scripts/verify-updater-round-trip.mjs",
        "          EXPECTED_RECOVERY_DIFF=$'apps/desktop/scripts/verify-updater-round-trip.mjs\\ntools/desktop-release-transaction.ts'",
        '          test "$(git diff --cached --name-only)" = "$EXPECTED_RECOVERY_DIFF"',
      ].join("\n"),
    ];
    for (const replacement of mutations) {
      const desktop = replaceRequired(source.desktop, updaterOverlay, replacement);
      expectIssue({ ...source, desktop }, "verify-production-update recovery must overlay exactly");
    }
  });

  it("uses a byte-deterministic npm alias packer", () => {
    const source = sources();
    expect(source.release).toContain('npm pack "$ALIAS_DIR/extract/package"');
    expect(source.release).not.toContain('tar -czf "$ALIAS_TARBALL"');
    const root = mkdtempSync(join(tmpdir(), "deterministic-npm-pack-"));
    try {
      const packageDirectory = join(root, "package");
      mkdirSync(packageDirectory);
      writeFileSync(
        join(packageDirectory, "package.json"),
        JSON.stringify({ name: "synthetic-alias", version: "1.0.0", files: ["index.js"] }),
      );
      writeFileSync(join(packageDirectory, "index.js"), "export {};\n");
      const archives = ["first", "second"].map((name) => {
        const output = join(root, name);
        mkdirSync(output);
        execFileSync(
          "npm",
          ["pack", packageDirectory, "--pack-destination", output, "--ignore-scripts", "--json"],
          { env: { ...process.env, npm_config_cache: join(root, "npm-cache") } },
        );
        return readFileSync(join(output, "synthetic-alias-1.0.0.tgz"));
      });
      expect(archives[0].equals(archives[1])).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("binds native verification to normalized signing evidence", () => {
    const source = sources();
    const desktop = replaceRequired(
      source.desktop,
      "SIGNING_RUN_ATTEMPT: ${{ needs.sign-macos.outputs.evidence_run_attempt }}",
      "SIGNING_RUN_ATTEMPT: ${{ github.run_attempt }}",
    );
    expectIssue({ ...source, desktop }, "normalized immutable signing evidence");
  });

  it("keeps native verification on the exact-four public envelope", () => {
    const source = sources();
    const desktop = source.desktop.replaceAll(
      '"$PUBLIC_ENVELOPE"',
      '"$RUNNER_TEMP/desktop-release"',
    );
    expectIssue({ ...source, desktop }, "exact-four public envelope");
  });

  it("requires explicit genesis and steady packaging plus native verification", () => {
    const source = sources();
    const wrongPackage = replaceRequired(source.desktop, "package:mac:genesis", "package:mac");
    expectIssue({ ...source, desktop: wrongPackage }, "desktop packaging modes");
    const wrongVerifier = replaceRequired(
      source.desktop,
      "verify:mac-genesis-release \\",
      "verify:mac-release \\",
    );
    expectIssue({ ...source, desktop: wrongVerifier }, "exact-four public envelope");
  });

  it("requires independent candidate identity continuity", () => {
    const source = sources();
    const desktop = replaceRequired(
      source.desktop,
      'test "$INDEPENDENT_CODE_DIRECTORY_SHA256" = "$CANDIDATE_CODE_DIRECTORY_SHA256"',
      "true",
    );
    expectIssue({ ...source, desktop }, "exact-four public envelope");
  });

  it("always removes the privately-created notarization key", () => {
    const source = sources();
    const noUmask = replaceRequired(source.desktop, "          umask 077\n", "");
    expectIssue({ ...source, desktop: noUmask }, "created privately and always removed");
    const noCleanup = replaceRequired(
      source.desktop,
      "      - name: Remove temporary notarization key\n        if: ${{ always() && inputs.source_run_id == 'none' }}\n        run: rm -f \"$RUNNER_TEMP/AuthKey.p8\"\n",
      "",
    );
    expectIssue({ ...source, desktop: noCleanup }, "created privately and always removed");
  });

  it("rejects direct GitHub expression interpolation in shell", () => {
    const source = sources();
    const desktop = replaceRequired(
      source.desktop,
      'test "$ARTIFACT_NAME" = "desktop-release-$EVIDENCE_RUN_ID-$EVIDENCE_RUN_ATTEMPT"',
      'test "$ARTIFACT_NAME" = "desktop-release-${{ github.run_id }}-$EVIDENCE_RUN_ATTEMPT"',
    );
    expectIssue({ ...source, desktop }, "run scripts must receive contexts through env");
  });

  it("retains npm provenance and successful publication-attempt checks", () => {
    const source = sources();
    const release = replaceRequired(
      source.release,
      "--workflow .github/workflows/release.yml",
      "--workflow release.yml",
    ).replace(
      "/actions/runs/$PUBLICATION_RUN_ID/attempts/$PUBLICATION_RUN_ATTEMPT",
      "/actions/runs/$PUBLICATION_RUN_ID/attempts/$GITHUB_RUN_ATTEMPT",
    );
    expectIssue({ ...source, release }, "exact provenance");
    expectIssue({ ...source, release }, "publication attempt tuple");
  });

  it("uses the public npm view dist evidence shape", () => {
    const source = sources();
    const fixture = JSON.parse(readFileSync(npmViewFixturePath, "utf8")) as {
      _integrity: string;
      dist: { integrity: string; attestations: { url: string } };
    };
    expect(fixture.dist.integrity).toBe(fixture._integrity);
    expect(fixture.dist.attestations.url).toBe(
      "https://registry.npmjs.org/-/npm/v1/attestations/cycling-coach@2026.7.28",
    );
    expect(source.release).toContain(".dist.integrity");
    expect(source.release).toContain(".dist.attestations.url");
    expect(source.release).not.toContain("._attestations.url");
  });
});
