<!-- trademark-lint:skip-file — the "Trademark hygiene" section below documents
the substitution table and must legitimately name the forbidden tokens. -->
# Contributing

## Branch Naming

Branches use full English-word prefixes (NOT the abbreviated commit-type form):

```
feature/<short-description>      — new feature or capability
bugfix/<short-description>       — bug fix
chore/<short-description>        — maintenance, deps, config
docs/<short-description>         — documentation only
refactor/<short-description>     — code restructuring, no behavior change
test/<short-description>         — test-only changes
performance/<short-description>  — performance improvement
ci/<short-description>           — CI/CD changes
style/<short-description>        — formatting, no logic change
```

Use lowercase, kebab-case. Keep the description under 50 characters.

Examples: `feature/session-management`, `bugfix/telegram-html-escape`, `chore/bump-intervals-api`, `performance/snapshot-harness-parallel`.

**Branch prefix vs commit type.** Branches use full words (`feature/`, `bugfix/`, `performance/`); commit messages keep Conventional Commits' abbreviated forms (`feat:`, `fix:`, `perf:`). This is deliberate — branch names are read by humans navigating `git branch`, commit messages are read by tooling.

## Pull Requests

- **Title**: imperative mood, under 70 characters (e.g., "Add session management and context compaction")
- **Branch**: always branch off `main`, PR back into `main`
- **One concern per PR**: don't mix unrelated features in a single PR
- **Description**: include a Summary (what and why) and a Test Plan

## Commits

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>
```

**Types:**

| Type | When |
|------|------|
| `feat` | New feature or capability |
| `fix` | Bug fix |
| `chore` | Maintenance, deps, config |
| `docs` | Documentation only |
| `refactor` | Code restructuring, no behavior change |
| `test` | Adding or updating tests |
| `perf` | Performance improvement |
| `ci` | CI/CD changes |
| `style` | Formatting, no logic change |

**Scope** is optional — use the module name when helpful: `core`, `telegram`, `soul`, `config`, `tools`, `memory`.

**Examples:**
```
feat(core): add rate limit retry with backoff
fix(soul): prevent coaching tone drift and emoji-only responses
chore(deps): update intervals-icu-api to 0.1.2
refactor(telegram): extract error formatting helper
test(endurance): add 100-message endurance test
docs(readme): document the /whatsnew command
```

**Rules:**
- Imperative mood: "add X", "fix Y", not "added X" or "fixes Y"
- Lowercase after the colon
- One logical change per commit when practical

**Flake remediation marker.** A commit that fixes or remediates a test flake carries a `flake:` note — either a `flake:` trailer line in the body or a `flake:` marker in the subject — so `git log --grep=flake` is a deliberate, durable measurement surface for flake-remediation history. This is a searchable marker for measurement, **not** a new Conventional-Commits type: the subject still uses one of the types above (`fix(test):`, `test:`, `chore:` as appropriate), and the release tooling does not interpret `flake:`.

## Test determinism

- **Restore real timers.** A test that calls `vi.useFakeTimers()` MUST restore real timers in `afterEach` via `vi.useRealTimers()`. The default `vi.restoreAllMocks()` does NOT restore fake timers, so a converted test that forgets this leaks faked time into the next test in the file.
- **Never run fake-timer tests under `isolate: false`.** Shared fake-timer state across files corrupts unrelated suites. The root `vitest.config.ts` pins `pool: "forks"` + `isolate: true` precisely so each file gets its own process and clock; do not weaken that to `isolate: false`.
- **Prefer fake-timer or injected-clock determinism over wall-clock sleeps.** Tests that assert on elapsed time (mutex acquire timeouts, run-sync phase ordering) drive time through `vi.advanceTimersByTimeAsync` or an injected clock seam rather than racing a real `setTimeout`, so they cannot flake on a slow runner.

## Trademark hygiene

The Reference submodule (`packages/core/src/reference/`) ports from an MIT-licensed upstream; the full attribution (author, copyright, license text, and source link) lives in [`NOTICE.md`](./NOTICE.md). That upstream was authored against TrainingPeaks vocabulary; this codebase uses [intervals.icu](https://intervals.icu)'s plain-English alternatives throughout. **PRs that introduce the forbidden tokens in Reference source or docs are rejected by the lint.**

| TrainingPeaks (forbidden) | intervals.icu (use this) |
|---------------------------|--------------------------|
| CTL                       | Fitness                  |
| ATL                       | Fatigue                  |
| TSB                       | Form                     |
| TSS                       | Load                     |
| IF                        | Intensity                |
| NP / "Normalized Power"   | weighted average power   |

`pnpm check:trademarks` runs the AST-walking linter at `tools/check-trademarks.ts`. For TypeScript files, only string literals, template literals, and comment trivia are checked — code identifiers are ignored, so a name like `IF` as an identifier never trips a false positive. Markdown files are scanned with word-boundary regex, with fenced code blocks excluded.

A file that legitimately needs to mention the forbidden tokens (the linter's own source, a glossary file, a test fixture) opts out by placing `trademark-lint:skip-file` in any commenting style within the first 1 KB of the file. Use sparingly; the default scope is the Reference submodule and `tools/`.

## Reference schema-version policy

Each cache file under `<coach-home>/data/` (`latest.json`, `history.json`, `intervals.json`, `routes.json`, `ftp_history.json`) declares its own `<FILE>_SCHEMA_VERSION` constant in `packages/core/src/reference/schemas/`. **Bump only the file whose shape changed; never bump them in lockstep.** The version is informational — Zod-strict-as-gate is what handles drift via discard-and-resync. There is no `migrations/` directory; a schema bump is a code-only change that triggers a fresh sync on the next `runSync()`.

## Fixture stewardship

The committed fixture at `packages/core/tests/fixtures/golden/realistic-athlete.json` is derived from a real operator's intervals.icu account, sanitized via `tools/sanitize-fixture.ts` per the schema-derived allowlist policy. The fixture lives next to a SHA-256 checksum (`realistic-athlete.json.sha256`) that CI verifies on every PR — a mismatch fires `realistic-athlete-fixture-checksum.test.ts` and surfaces accidental in-place mutation (bad merge, editor save, formatter pass).

The deeper provenance check — re-running the sanitize CLI against the saved source mock and comparing bytes — is operator-machine-only: `sanitize-cli-fixture-stability.test.ts` skips when `docs/mocks/intervals-icu-raw-2026-05-11.json` is absent (gitignored, so absent on CI and on fresh clones). The operator is responsible for re-running it before any fixture-regen PR.

**Operator regen flow:**

```
INTERVALS_API_KEY=… pnpm exec tsx tools/fetch-real-athlete.ts
pnpm exec tsx tools/sanitize-fixture.ts <bundle path printed by fetch-real-athlete> realistic-athlete --force
```

The fetch step writes the unsanitized bundle to a private per-run temp directory (mode 0600) and prints the path; delete it once the sanitized fixture is committed.

The second command writes both `realistic-athlete.json` and `realistic-athlete.json.sha256`. Commit both, or neither. Reviewers don't read the 70 KB JSON diff line-by-line — the review focuses on the `SanitizeSummary` the CLI prints (which keys were dropped, which were transformed) and a green metric-test suite.

**Reviewer checklist for schema-adding PRs.** When a PR adds a field to any of the seven input schemas in `packages/core/src/reference/schemas/inputs.ts`, the new field is now auto-allowed in committed fixtures via `ALLOWED_FIXTURE_KEYS`. Confirm the field is either (a) not present in the source mock, or (b) carries no PII once the mock includes it. If neither holds, the field must land with a value-level transform in `TRANSFORMS` (see `source` as precedent) or be excluded via a schema-shape carve-out.

## Fixture privacy

Golden fixtures under `packages/core/tests/fixtures/golden/` derive from a real intervals.icu athlete account. Two classes of identifier must NEVER reach a committed fixture:

1. **Account-linking ids.** Real intervals.icu activity ids have the shape `i` + 8-9 digits (string form) or a large bare integer (number form). The operator sanitizer (`tools/sanitize-fixture.ts` -> `tools/sanitize-fixture-transform.ts`) redacts every numeric `id`/`*_id` to the `12345` sentinel; synthetic build fixtures use the reserved ranges `90101+` (curve-equipped) and `90201+` (dfa-equipped).
2. **The athlete's real training calendar.** ISO dates are no longer ridden through verbatim — the sanitizer and the `build-*-fixture.ts` scripts shift every date back one full Gregorian cycle to a synthetic pre-2010 epoch via the shared `tools/shift-to-synthetic-epoch.ts` util. A full-cycle (year -= 28) shift preserves every date-to-date day-delta exactly, so temporal metrics stay bit-identical in shape AND value.

A static gate, `pnpm check:fixture-privacy` (`tools/check-fixture-privacy.ts`), runs in CI and enforces both invariants by SHAPE: it forbids the real id shape `i\d{8,9}` anywhere under `packages/` and `tools/` (outside the documented synthetic-placeholder allowlist or a `fixture-privacy-lint:skip-file` marker), and forbids ISO dates with year >= 2015 inside real-data golden fixtures. Fully-synthetic golden fixtures (hand-crafted / fuzz-derived, zero real data — see the provenance column in `packages/core/tests/fixtures/README.md`) are exempt from the date rule via `SYNTHETIC_FIXTURE_ALLOWLIST`. After regenerating any fixture, run `pnpm check:fixture-privacy` locally; if it flags a date, you forgot to run the regen through the sanitizer / build script. To exempt a file that legitimately needs a forbidden shape (the linter's own source, its test fixtures), add `fixture-privacy-lint:skip-file` within the first 1 KB — same convention as the trademark lint.

## Telegram allowlist file

The bot enforces a per-user-ID allowlist via `~/.cycling-coach/allowed-senders.json` (mode `0600`). Schema and validation live in `packages/core/src/channels/allowed-senders.ts`. CLI mutations (`add-sender`, `remove-sender`) acquire a PID lockfile at `~/.cycling-coach/.allowed-senders.lock` so concurrent invocations serialize cleanly. **Do not edit `allowed-senders.json` by hand while the bot is running** — the bot re-reads it on every inbound message, but a hand-edit during a write will lose updates. Use the CLI subcommands instead.

`dmPolicy: "open"` is rejected when read from the file (defense in depth — only settable via the `CYCLING_COACH_DM_POLICY=open` env var, intended for debugging). The setup wizard never offers it.

## Versioning

Calendar-based for npm-published binaries: `YYYY.M.D` (e.g., `2026.4.16` — first release of the day; `2026.4.16-1` — patch later the same day; `2026.4.17` — next day). Private workspace packages (`@enduragent/*`, stub binaries) use SemVer and are not published. See ADR-0007 and ADR-0009.

## Releasing

Changesets-driven and CI-automated. Contributors do **not** create tags or GitHub Releases by hand — those steps are wrong, and the tag namespace is `<package>@<version>` (e.g., `cycling-coach@2026.5.4`), not `vYYYY.M.D`.

1. **Add a changeset to your PR.** Run `pnpm exec changeset`, pick the affected publishable package(s), describe the change in athlete-readable language. Commit the resulting `.changeset/<slug>.md`. A PR with a user-visible change but no changeset will skip release — this is intentional, not a bug.

   For user-visible changes, add a `User-facing: <one-sentence description>` line at the top of the changeset body — see `.changeset/README.md` for the convention. The bot's `/whatsnew` command surfaces only those lines to athletes; engineering details, hashes, and infra-only changesets stay in `CHANGELOG.md` for git history but never reach users.
2. **Merge your PR to `main`.** `version-pr.yml` opens (or updates) a bot-managed "Version Packages" PR aggregating all pending changesets.
3. **Merge the "Version Packages" PR when ready to ship.** It bumps `package.json` + CHANGELOG.md for the listed packages plus their internal dependents (per `updateInternalDependencies: "patch"` in `.changeset/config.json`). On merge, `version-pr.yml` then auto-pushes `<package>@<version>` tags for every **non-private** bumped package.
4. **`release.yml` fires on the tag.** It builds, runs tests, packs the binary and smoke-installs the tarball, publishes to npm via OIDC trusted publisher (no `NPM_TOKEN`), and auto-creates the GitHub Release with notes extracted from `CHANGELOG.md`.

Today only `cycling-coach` is `private: false`, so only `cycling-coach@<v>` is tagged. When a stub binary (`running-coach`, `duathlon-coach`) graduates by flipping `private: false`, it auto-tags on the next Version-PR merge.

**If a release fails partway** (e.g., a flaky smoke test), re-run `release.yml` via Actions → "Run workflow" with the existing tag as input. `workflow_dispatch` is a fallback for re-running on a tag that already exists — it does **not** create the tag, so don't use it before the version-PR-merge has pushed one.

`tools/bump-binaries-to-calver.ts` runs after `changeset version` to override the SemVer bump for binary packages with today's CalVer (handles same-day re-releases by querying npm).
