# Contributing

## Branch Naming

```
feat/<short-description>   — new feature
fix/<short-description>    — bug fix
chore/<short-description>  — maintenance, deps, config
docs/<short-description>   — documentation only
refactor/<short-description> — code restructuring, no behavior change
```

Use lowercase, kebab-case. Keep it under 50 characters.

Examples: `feat/session-management`, `fix/telegram-html-escape`, `chore/bump-intervals-api`.

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
docs(plan): add battle plan for rate limit fix
```

**Rules:**
- Imperative mood: "add X", "fix Y", not "added X" or "fixes Y"
- Lowercase after the colon
- One logical change per commit when practical

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
