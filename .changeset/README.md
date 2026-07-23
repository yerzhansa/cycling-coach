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
- The token must start the line after optional indentation. Generated changelog lines may prefix it with a Markdown bullet and an optional commit hash of 7 or more hexadecimal characters followed by a colon (for example, `- abc1234: User-facing: ...`). Mid-line prose that merely mentions `User-facing:` is ignored.
- The convention propagates from `.changeset/*.md` → `CHANGELOG.md` → GitHub Release body automatically; `/whatsnew` reads the GitHub Release body.

## Binary packages and CalVer

Library packages (`@enduragent/*`) follow SemVer via standard changesets bumps.

Binary packages (`cycling-coach`, `running-coach`, `duathlon-coach`) use stable, SemVer-compatible CalVer: `YYYY.MONTH.RELEASE-WITHIN-MONTH`. The first release after a UTC month or year rollover uses `.0`; each later release in that UTC month increments the third component from the highest version already occupied in npm or the committed repository. New releases never use a prerelease suffix. Historical `YYYY.M.P-N` versions remain valid history and count as occupying patch `P`, but are never generated again.

Changesets doesn't natively understand this policy, so the publish workflow runs `tools/bump-binaries-to-calver.ts` after `changeset version`. Your changeset should still select a normal patch, minor, or major bump; that choice is overridden for binary packages. The script rewrites only the new top changelog header when necessary and never rewrites historical entries.
