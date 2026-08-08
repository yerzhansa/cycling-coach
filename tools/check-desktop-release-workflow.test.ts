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
  return source.replace(search, replacement);
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
    expect(source.coordinator).toContain('--ref "$RELEASE_TAG"');
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

  it("requires a desktop changelog draft with stable non-latest semantics", () => {
    const source = sources();
    const wrongChangelog = replaceRequired(
      source.coordinator,
      "apps/desktop/CHANGELOG.md",
      "packages/cycling-coach/CHANGELOG.md",
    );
    const latestDraft = replaceRequired(
      source.coordinator,
      "--draft --latest=false --target",
      "--draft --target",
    );
    for (const coordinator of [wrongChangelog, latestDraft]) {
      expectIssue({ ...source, coordinator }, "non-latest draft from the desktop changelog");
    }
  });

  it("requires one exact-tag, npm-independent child dispatch and awaits it", () => {
    const source = sources();
    const wrongRef = replaceRequired(source.coordinator, '--ref "$RELEASE_TAG"', "--ref main");
    const npmCoupled = replaceRequired(
      source.coordinator,
      '            -f desktop_version="$DESKTOP_VERSION" \\\n',
      '            -f npm_version="$DESKTOP_VERSION" \\\n            -f desktop_version="$DESKTOP_VERSION" \\\n',
    );
    const notAwaited = replaceRequired(
      source.coordinator,
      'gh run watch "$DESKTOP_RUN_ID" --repo "$GITHUB_REPOSITORY" --interval 15 --exit-status',
      'gh run view "$DESKTOP_RUN_ID" --repo "$GITHUB_REPOSITORY"',
    );
    for (const coordinator of [wrongRef, npmCoupled, notAwaited]) {
      expectIssue({ ...source, coordinator }, "npm-independent child tuple");
    }
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

  it("authorizes only the active desktop coordinator", () => {
    const source = sources();
    const wrongPath = replaceRequired(
      source.desktop,
      ".github/workflows/desktop-release-coordinator.yml",
      ".github/workflows/release.yml",
    );
    const noAttempt = replaceRequired(
      source.desktop,
      'test "$(printf \'%s\' "$COORDINATOR" | jq -r \'.run_attempt\')" = "$COORDINATOR_RUN_ATTEMPT"',
      "true",
    );
    for (const desktop of [wrongPath, noAttempt]) {
      expectIssue({ ...source, desktop }, "authorize only its active desktop coordinator");
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
      "contents: read\n    outputs:",
      "contents: write\n    outputs:",
    ).replaceAll(githubTokenBinding, "CSC_LINK: ${{ secrets.CSC_LINK }}");
    expectIssue({ ...source, desktop }, "macOS signing permissions");
    expectIssue({ ...source, desktop }, "escaped the signing job");
  });

  it("requires workspace dependencies and signing environment secrets before packaging", () => {
    const source = sources();
    const noBuild = replaceRequired(source.desktop, "      - run: pnpm -r build\n", "");
    expectIssue({ ...source, desktop: noBuild }, "build workspace dependencies before packaging");
    const unchecked = replaceRequired(
      source.desktop,
      "for secret_name in CSC_LINK CSC_KEY_PASSWORD APPLE_API_KEY_ID APPLE_API_ISSUER APPLE_API_KEY_P8_BASE64; do",
      "for secret_name in CSC_LINK; do",
    );
    expectIssue({ ...source, desktop: unchecked }, "fail closed when an environment secret");
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

  it("requires the native production-feed round trip and gated activation", () => {
    const source = sources();
    const noRoundTrip = replaceRequired(
      source.desktop,
      "test:macos-update-roundtrip",
      "test:disabled-roundtrip",
    );
    expectIssue({ ...source, desktop: noRoundTrip }, "production-feed N-to-N+1 round trip");
    const bypass = replaceRequired(
      source.desktop,
      "needs.verify-production-update.result == 'success'",
      "needs.verify-production-update.result != 'failure'",
    );
    expectIssue({ ...source, desktop: bypass }, "mode-specific acceptance");
  });

  it("requires compensation to restore prior latest and withdraw the candidate", () => {
    const source = sources();
    const desktop = replaceRequired(
      source.desktop,
      "needs.activate-release.result != 'success'",
      "needs.activate-release.result == 'failure'",
    );
    expectIssue({ ...source, desktop }, "restore prior latest");
  });

  it("binds recovery tooling to the coordinator and audited overlay", () => {
    const source = sources();
    const unbound = replaceRequired(
      source.desktop,
      'test "$RELEASE_TOOLING_COMMIT" = "$WORKFLOW_COMMIT"',
      "true",
    );
    expectIssue({ ...source, desktop: unbound }, "active desktop coordinator");
    const productOverlay = replaceRequired(
      source.desktop,
      "apps/desktop/scripts/macos-release-plan.d.mts\\n",
      "apps/desktop/src/main/index.ts\\n",
    );
    expectIssue({ ...source, desktop: productOverlay }, "overlay only audited release tooling");
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

  it("binds every consumer to the successful signing attempt", () => {
    const source = sources();
    const desktop = replaceRequired(
      source.desktop,
      "SIGNING_RUN_ATTEMPT: ${{ needs.sign-macos.outputs.workflow_run_attempt }}",
      "SIGNING_RUN_ATTEMPT: ${{ github.run_attempt }}",
    );
    expectIssue({ ...source, desktop }, "successful signing attempt");
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
      '      - name: Remove temporary notarization key\n        if: ${{ always() }}\n        run: rm -f "$RUNNER_TEMP/AuthKey.p8"\n',
      "",
    );
    expectIssue({ ...source, desktop: noCleanup }, "created privately and always removed");
  });

  it("rejects direct GitHub expression interpolation in shell", () => {
    const source = sources();
    const desktop = replaceRequired(
      source.desktop,
      'test "$ARTIFACT_NAME" = "desktop-release-$GITHUB_RUN_ID-$SIGNING_RUN_ATTEMPT"',
      'test "$ARTIFACT_NAME" = "desktop-release-${{ github.run_id }}-$SIGNING_RUN_ATTEMPT"',
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
