# Changesets

Changesets is how releases are managed in this monorepo.

## Adding a changeset

When you make a change that should ship in a release, run:

```bash
pnpm exec changeset
```

The CLI will ask which packages changed and how (patch/minor/major), and write a markdown file to `.changeset/`. Commit that file with your PR.

When the PR merges to main, a "Version PR" will be opened (or updated) by the changesets GitHub Action, aggregating pending changesets into version bumps + CHANGELOG entries. Merging the Version PR triggers the publish workflow.

## Why `commit: false`?

We let the bot's PR handle commits, not the local CLI. Local `pnpm exec changeset` only writes the `.changeset/*.md` file; the bot does the actual version bump + CHANGELOG generation in its own commit.

## User-facing notes

The Telegram bot's `/whatsnew` command surfaces release notes to athletes. To keep that view athlete-friendly and free of engineering chatter, prefix any user-visible change with a `User-facing:` line at the top of the changeset body:

```
---
"cycling-coach": patch
---

User-facing: Added /review command to summarize last week's training.

Engineering details (anything you want — code refs, hash, rationale). Ignored by /whatsnew.
```

Rules:

- One sentence per `User-facing:` line, written in plain English in the bot's voice.
- Multiple user-visible changes in one changeset → multiple `User-facing:` lines, each becomes a bullet.
- Pure-infra changes (CI, publishing, build tooling, internal refactors) omit the line — they stay in `CHANGELOG.md` for git history but don't reach athletes.
- The line is parsed by a simple regex (`/User-facing:\s*(.+)$/i`); anything after the colon on the same line is the bullet text.
- The convention propagates from `.changeset/*.md` → `CHANGELOG.md` → GitHub Release body automatically; `/whatsnew` reads the GitHub Release body.

## Binary packages and CalVer

Library packages (`@enduragent/*`) follow SemVer via standard changesets bumps.

Binary packages (`cycling-coach`, `running-coach`, `duathlon-coach`) are CalVer (`YYYY.M.D[-N]`). Changesets doesn't natively understand CalVer, so the publish workflow runs `tools/bump-binaries-to-calver.ts` after `changeset version` to override the binary bumps with today's CalVer string. Your changeset should still be written normally (any bump type — the CalVer override ignores the choice for binaries).
