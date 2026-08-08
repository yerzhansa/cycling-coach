import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { inspectDesktopReleaseWorkflows } from "./check-desktop-release-workflow.js";

const releasePath = resolve(".github/workflows/release.yml");
const desktopPath = resolve(".github/workflows/desktop-release.yml");
const versionPath = resolve(".github/workflows/version-pr.yml");
const npmViewFixturePath = resolve("tools/fixtures/npm-view-cycling-coach-2026.7.28.json");

function sources(): { release: string; desktop: string; version: string } {
  return {
    release: readFileSync(releasePath, "utf8"),
    desktop: readFileSync(desktopPath, "utf8"),
    version: readFileSync(versionPath, "utf8"),
  };
}

function inspect(release: string, desktop: string, version = sources().version): string[] {
  return inspectDesktopReleaseWorkflows(release, desktop, version);
}

describe("desktop release workflow policy", () => {
  it("accepts the canonical coordinator and environment-bound workflow", () => {
    const source = sources();
    expect(inspect(source.release, source.desktop, source.version)).toEqual([]);
    expect(source.release).toContain("desktop_version: ${{ steps.parse.outputs.desktop_version }}");
    expect(source.release).toContain("NPM_VERSION: ${{ needs.parse-tag.outputs.version }}");
    expect(source.release).toContain(
      "DESKTOP_VERSION: ${{ needs.parse-tag.outputs.desktop_version }}",
    );
    expect(source.release).toContain("gh workflow run desktop-release.yml");
    expect(source.release).toContain(
      'gh run watch "$DESKTOP_RUN_ID" --repo "$GITHUB_REPOSITORY" --interval 15 --exit-status',
    );
    expect(source.desktop).toContain('--npm-version "$NPM_VERSION"');
    expect(source.desktop).toContain('--desktop-version "$DESKTOP_VERSION"');
  });

  it("rejects coupling the desktop version back to the npm version", () => {
    const source = sources();
    const release = source.release.replace(
      "DESKTOP_VERSION: ${{ needs.parse-tag.outputs.desktop_version }}",
      "DESKTOP_VERSION: ${{ needs.parse-tag.outputs.version }}",
    );
    expect(
      inspect(release, source.desktop).some((issue) =>
        issue.includes("frozen version authorities"),
      ),
    ).toBe(true);
  });

  it("rejects pnpm separators that become the transaction command", () => {
    const source = sources();
    const release = source.release.replace(
      "desktop-release:transaction verify-npm-provenance",
      "desktop-release:transaction -- verify-npm-provenance",
    );
    const desktop = source.desktop.replace(
      "desktop-release:transaction baseline",
      "desktop-release:transaction -- baseline",
    );
    for (const mutated of [inspect(release, source.desktop), inspect(source.release, desktop)]) {
      expect(mutated.some((issue) => issue.includes("pnpm argument separator"))).toBe(true);
    }
  });

  it("rejects signing write permission and publication signing secrets", () => {
    const source = sources();
    const mutated = source.desktop
      .replace("contents: read\n    outputs:", "contents: write\n    outputs:")
      .replaceAll("GITHUB_TOKEN: ${{ github.token }}", "CSC_LINK: ${{ secrets.CSC_LINK }}");
    const issues = inspect(source.release, mutated);
    expect(issues.some((issue) => issue.includes("macOS signing permissions"))).toBe(true);
    expect(issues.some((issue) => issue.includes("escaped the signing job"))).toBe(true);
  });

  it("requires workspace dependencies before macOS packaging", () => {
    const source = sources();
    const desktop = source.desktop.replace("      - run: pnpm -r build\n", "");
    expect(
      inspect(source.release, desktop).some((issue) =>
        issue.includes("build workspace dependencies before packaging"),
      ),
    ).toBe(true);
  });

  it("requires a direct dispatch and available signing environment secrets", () => {
    const source = sources();
    const reusable = source.desktop.replace("workflow_dispatch:", "workflow_call:");
    const unchecked = source.desktop.replace(
      "for secret_name in CSC_LINK CSC_KEY_PASSWORD APPLE_API_KEY_ID APPLE_API_ISSUER APPLE_API_KEY_P8_BASE64; do",
      "for secret_name in CSC_LINK; do",
    );
    expect(
      inspect(source.release, reusable).some((issue) =>
        issue.includes("workflow_dispatch-only"),
      ),
    ).toBe(true);
    expect(
      inspect(source.release, unchecked).some((issue) =>
        issue.includes("fail closed when an environment secret is unavailable"),
      ),
    ).toBe(true);
  });

  it("rejects reordered jobs and draft semantics on the default package-only path", () => {
    const source = sources();
    const desktop = source.desktop.replace("needs: sign-macos", "needs: promote-latest");
    const release = source.release.replace(
      'gh release create "$TAG" --title "$TAG" --notes "$BODY"',
      'gh release create "$TAG" --draft --latest=false --title "$TAG" --notes "$BODY"',
    );
    const issues = inspect(release, desktop);
    expect(issues.some((issue) => issue.includes("verification must follow signing"))).toBe(true);
    expect(issues.some((issue) => issue.includes("create-normal-or-leave-existing"))).toBe(true);
  });

  it("rejects reusable triggers and activation that bypasses native acceptance", () => {
    const source = sources();
    const desktop = source.desktop
      .replace("workflow_dispatch:", "workflow_call:")
      .replace(
        "needs.verify-production-update.result == 'success'",
        "needs.verify-production-update.result != 'failure'",
      );
    const issues = inspect(source.release, desktop);
    expect(issues.some((issue) => issue.includes("workflow_dispatch-only"))).toBe(true);
    expect(issues.some((issue) => issue.includes("mode-specific acceptance gate"))).toBe(true);
  });

  it("requires observation, production-feed round trip, and compensation", () => {
    const source = sources();
    const mutations = [
      {
        desktop: source.desktop.replace(
          "desktop-release:transaction observe",
          "desktop-release:transaction verify",
        ),
        issue: "bind latest before provisional publication",
      },
      {
        desktop: source.desktop.replace("test:macos-update-roundtrip", "test:disabled-roundtrip"),
        issue: "native production-feed N-to-N+1 round trip",
      },
      {
        desktop: source.desktop.replace(
          "needs.activate-release.result != 'success'",
          "needs.activate-release.result == 'failure'",
        ),
        issue: "restore the observed latest",
      },
    ];
    for (const mutation of mutations) {
      expect(
        inspect(source.release, mutation.desktop).some((issue) => issue.includes(mutation.issue)),
      ).toBe(true);
    }
  });

  it("rejects a desktop dispatcher without actions write permission", () => {
    const source = sources();
    const release = source.release.replace(
      "    permissions:\n      actions: write\n      contents: read\n    steps:",
      "    steps:",
    );
    expect(
      inspect(release, source.desktop).some((issue) =>
        issue.includes("desktop dispatcher permissions"),
      ),
    ).toBe(true);
  });

  it("requires the coordinator to correlate and await the dispatched desktop run", () => {
    const source = sources();
    const release = source.release
      .replace('--arg title "$EXPECTED_TITLE"', '--arg title "$RELEASE_TAG"')
      .replace(
        'gh run watch "$DESKTOP_RUN_ID" --repo "$GITHUB_REPOSITORY" --interval 15 --exit-status',
        'gh run view "$DESKTOP_RUN_ID"',
      );
    expect(
      inspect(release, source.desktop).some((issue) =>
        issue.includes("dispatch, correlate, and await the exact child run"),
      ),
    ).toBe(true);
  });

  it("requires explicit repository context without a checkout", () => {
    const source = sources();
    const release = source.release.replace(
      '--repo "$GITHUB_REPOSITORY"',
      '--repo "missing/repository"',
    );
    expect(
      inspect(release, source.desktop).some((issue) =>
        issue.includes("dispatch, correlate, and await the exact child run"),
      ),
    ).toBe(true);
  });

  it("rejects desktop signing that is not bound to an active release coordinator", () => {
    const source = sources();
    const desktop = source.desktop
      .replace("    needs: authorize-coordinator\n", "")
      .replace("test \"$(printf '%s' \"$COORDINATOR\" | jq -r '.status')\" = 'in_progress'", "true");
    expect(
      inspect(source.release, desktop).some((issue) =>
        issue.includes("bind to its active release coordinator"),
      ),
    ).toBe(true);
  });

  it("binds manual recovery tooling to the coordinator and exact release overlay", () => {
    const source = sources();
    const unboundDispatch = source.release.replace(
      '-f tooling_commit="$RELEASE_TOOLING_COMMIT" \\\n',
      "",
    );
    const unboundCoordinator = source.desktop.replace(
      'test "$RELEASE_TOOLING_COMMIT" = "$WORKFLOW_COMMIT"',
      "true",
    );
    const productOverlay = source.desktop.replace(
      "apps/desktop/scripts/macos-release-plan.d.mts\\n",
      "apps/desktop/src/main/index.ts\\n",
    );

    expect(source.desktop).not.toContain(
      'git diff --name-only "$RELEASE_COMMIT" "$RELEASE_TOOLING_COMMIT"',
    );

    expect(
      inspect(unboundDispatch, source.desktop).some((issue) =>
        issue.includes("dispatch, correlate, and await"),
      ),
    ).toBe(true);
    expect(
      inspect(source.release, unboundCoordinator).some((issue) =>
        issue.includes("active release coordinator"),
      ),
    ).toBe(true);
    expect(
      inspect(source.release, productOverlay).some((issue) =>
        issue.includes("overlay only audited release tooling"),
      ),
    ).toBe(true);
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

  it("binds downstream verification to the successful signing attempt", () => {
    const source = sources();
    const desktop = source.desktop.replace(
      "SIGNING_RUN_ATTEMPT: ${{ needs.sign-macos.outputs.workflow_run_attempt }}",
      "SIGNING_RUN_ATTEMPT: ${{ github.run_attempt }}",
    );
    expect(
      inspect(source.release, desktop).some((issue) =>
        issue.includes("successful signing attempt"),
      ),
    ).toBe(true);
  });

  it("keeps the audit manifest outside the native exact-four verifier boundary", () => {
    const source = sources();
    const desktop = source.desktop.replaceAll(
      '"$PUBLIC_ENVELOPE"',
      '"$RUNNER_TEMP/desktop-release"',
    );
    expect(
      inspect(source.release, desktop).some((issue) =>
        issue.includes("exact-four public envelope"),
      ),
    ).toBe(true);
  });

  it("requires explicit genesis packaging, acknowledgement, and native verification", () => {
    const source = sources();
    const wrongPackage = source.desktop.replace("package:mac:genesis", "package:mac");
    const wrongAcknowledgement = source.desktop.replace(
      "ENDURAGENT_MACOS_GENESIS_VERSION: ${{ inputs.desktop_version }}",
      "ENDURAGENT_MACOS_GENESIS_VERSION: 0.0.1",
    );
    const missingGenesisVerifier = source.desktop.replace(
      "verify:mac-genesis-release --",
      "verify:mac-release --",
    );
    const sealedGenesisVerifier = source.desktop.replace(
      '                "$PUBLIC_ENVELOPE" \\\n',
      '                "$RUNNER_TEMP/desktop-release" \\\n',
    );
    const escapedPackaging = source.desktop.replace(
      "pnpm desktop-release:transaction verify \\\n",
      "pnpm --filter @enduragent/desktop package:mac:genesis\n          pnpm desktop-release:transaction verify \\\n",
    );
    const constantSigningMode = source.desktop.replace(
      "RELEASE_MODE: ${{ inputs.mode }}\n          ENDURAGENT_DEVELOPER_ID_IDENTITY:",
      "RELEASE_MODE: steady\n          ENDURAGENT_DEVELOPER_ID_IDENTITY:",
    );
    const constantVerificationMode = source.desktop.replace(
      '--output "$PUBLIC_ENVELOPE"\n          case "$RELEASE_MODE" in',
      '--output "$PUBLIC_ENVELOPE"\n          case "genesis" in',
    );
    const commentedSigningSelector = source.desktop.replace(
      '          case "$RELEASE_MODE" in',
      '          case "genesis" in # case "$RELEASE_MODE" in',
    );
    const commentedVerificationSelector = source.desktop.replace(
      '--output "$PUBLIC_ENVELOPE"\n          case "$RELEASE_MODE" in',
      '--output "$PUBLIC_ENVELOPE"\n          case "genesis" in # case "$RELEASE_MODE" in',
    );

    for (const mutated of [
      wrongPackage,
      wrongAcknowledgement,
      missingGenesisVerifier,
      sealedGenesisVerifier,
      escapedPackaging,
      constantSigningMode,
      constantVerificationMode,
      commentedSigningSelector,
      commentedVerificationSelector,
    ]) {
      expect(
        inspect(source.release, mutated).some(
          (issue) =>
            issue.includes("packaging modes") || issue.includes("exact-four public envelope"),
        ),
      ).toBe(true);
    }
  });

  it("requires independent candidate identity binding", () => {
    const source = sources();
    const mutations = [
      source.desktop.replace('test "$INDEPENDENT_CDHASH" = "$CANDIDATE_CDHASH"', "true"),
      source.desktop.replace(
        'test "$INDEPENDENT_CODE_DIRECTORY_SHA256" = "$CANDIDATE_CODE_DIRECTORY_SHA256"',
        "true",
      ),
      source.desktop.replace(
        'test "$INDEPENDENT_SIGNING_IDENTITY" = "$SIGNING_IDENTITY"',
        '# test "$INDEPENDENT_SIGNING_IDENTITY" = "$SIGNING_IDENTITY"',
      ),
    ];

    for (const mutated of mutations) {
      expect(
        inspect(source.release, mutated).some((issue) =>
          issue.includes("mode-specific native verification"),
        ),
      ).toBe(true);
    }
  });

  it("keeps signing credentials exclusive and always removes the notarization key", () => {
    const source = sources();
    const cleanupStep =
      '      - name: Remove temporary notarization key\n        if: ${{ always() }}\n        run: rm -f "$RUNNER_TEMP/AuthKey.p8"\n';
    const missingCleanup = source.desktop.replace(cleanupStep, "");
    const permissiveCreation = source.desktop.replace("          umask 077\n", "");
    const divergentKeyPath = source.desktop.replace(
      "APPLE_API_KEY: ${{ runner.temp }}/AuthKey.p8",
      "APPLE_API_KEY: ${{ runner.temp }}/OtherKey.p8",
    );
    const earlyCleanup = source.desktop
      .replace(cleanupStep, "")
      .replace(
        "      - name: Build signed and notarized macOS envelope\n",
        `${cleanupStep}      - name: Build signed and notarized macOS envelope\n`,
      );
    const leakedVerifierSecret = source.desktop.replace(
      "  verify-macos-envelope:\n    runs-on: macos-15",
      "  verify-macos-envelope:\n    environment: desktop-macos-signing\n    env:\n      CSC_LINK: ${{ secrets.CSC_LINK }}\n    runs-on: macos-15",
    );

    expect(
      inspect(source.release, missingCleanup).some((issue) => issue.includes("always removed")),
    ).toBe(true);
    expect(
      inspect(source.release, permissiveCreation).some((issue) =>
        issue.includes("created privately"),
      ),
    ).toBe(true);
    for (const mutated of [divergentKeyPath, earlyCleanup]) {
      expect(
        inspect(source.release, mutated).some((issue) => issue.includes("always removed")),
      ).toBe(true);
    }
    const leakedIssues = inspect(source.release, leakedVerifierSecret);
    expect(leakedIssues.some((issue) => issue.includes("escaped the signing job"))).toBe(true);
    expect(leakedIssues.some((issue) => issue.includes("exclusive to the signing job"))).toBe(true);
  });

  it("keeps desktop opt-in and defaults cycling releases to package-only", () => {
    const source = sources();
    expect(source.release.match(/vars\.ENABLE_DESKTOP_MACOS_RELEASE/gu)).toHaveLength(1);
    expect(source.release).toContain("needs.parse-tag.outputs.desktop_enabled == 'true'");
    expect(source.release).toContain("needs.parse-tag.outputs.desktop_enabled != 'true'");
    const alwaysEnabled = source.release.replaceAll(
      "needs.parse-tag.outputs.package == 'cycling-coach' && needs.parse-tag.outputs.desktop_enabled == 'true'",
      "needs.parse-tag.outputs.package == 'cycling-coach'",
    );
    expect(
      inspect(alwaysEnabled, source.desktop).some((issue) =>
        issue.includes("frozen coordinator opt-in"),
      ),
    ).toBe(true);
    const strandsCycling = source.release.replace(
      "needs.parse-tag.outputs.package != 'cycling-coach' || needs.parse-tag.outputs.desktop_enabled != 'true'",
      "needs.parse-tag.outputs.package != 'cycling-coach'",
    );
    expect(
      inspect(strandsCycling, source.desktop).some((issue) => issue.includes("package-only")),
    ).toBe(true);
    const splitBrain = source.release.replace(
      "DESKTOP_ENABLED: ${{ needs.parse-tag.outputs.desktop_enabled }}",
      "DESKTOP_ENABLED: ${{ vars.ENABLE_DESKTOP_MACOS_RELEASE }}",
    );
    expect(
      inspect(splitBrain, source.desktop).some((issue) => issue.includes("read once and frozen")),
    ).toBe(true);
  });

  it("rejects GitHub expressions interpolated directly into shell scripts", () => {
    const source = sources();
    const desktop = source.desktop.replace(
      'test "$ARTIFACT_NAME" = "desktop-release-$GITHUB_RUN_ID-$SIGNING_RUN_ATTEMPT"',
      'test "$ARTIFACT_NAME" = "desktop-release-${{ github.run_id }}-$SIGNING_RUN_ATTEMPT"',
    );
    expect(
      inspect(source.release, desktop).some((issue) =>
        issue.includes("run scripts must receive contexts through env"),
      ),
    ).toBe(true);
  });

  it("requires queued exact-tag dispatch recovery", () => {
    const source = sources();
    const version = source.version
      .replace("  queue: max\n", "")
      .replace('--ref "$TAG" -f tag="$TAG"', '--ref main -f tag="$TAG"');
    const issues = inspect(source.release, source.desktop, version);
    expect(issues.some((issue) => issue.includes("queue:max"))).toBe(true);
    expect(issues.some((issue) => issue.includes("exact-tag release dispatch"))).toBe(true);
  });

  it("requires verified npm outputs and the successful publication tuple", () => {
    const source = sources();
    const release = source.release
      .replace(
        "NPM_INTEGRITY: ${{ needs.verify-npm-publication.outputs.npm_integrity }}",
        "NPM_INTEGRITY: ${{ needs.publish-npm.outputs.npm_integrity }}",
      )
      .replace("--workflow .github/workflows/release.yml", "--workflow release.yml")
      .replace(
        "/actions/runs/$PUBLICATION_RUN_ID/attempts/$PUBLICATION_RUN_ATTEMPT",
        "/actions/runs/$PUBLICATION_RUN_ID/attempts/$GITHUB_RUN_ATTEMPT",
      );
    const issues = inspect(release, source.desktop);
    expect(issues.some((issue) => issue.includes("verified npm outputs"))).toBe(true);
    expect(issues.some((issue) => issue.includes("exact signed provenance"))).toBe(true);
    expect(issues.some((issue) => issue.includes("publication attempt tuple"))).toBe(true);
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
