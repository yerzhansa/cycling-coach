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

## Binary packages and CalVer

Library packages (`@enduragent/*`) follow SemVer via standard changesets bumps.

Binary packages (`cycling-coach`, `running-coach`, `duathlon-coach`) are CalVer (`YYYY.M.D[-N]`). Changesets doesn't natively understand CalVer, so the publish workflow runs `tools/bump-binaries-to-calver.ts` after `changeset version` to override the binary bumps with today's CalVer string. Your changeset should still be written normally (any bump type — the CalVer override ignores the choice for binaries).
