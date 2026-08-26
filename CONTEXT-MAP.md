# Context Map

This repo is a multi-package monorepo for the enduragent AI coaching agent platform — Core publishes the Sport contract, sport packages implement it, binary packages ship them.

## Contexts

- [Core](./packages/core/CONTEXT.md) — sport-agnostic infrastructure: agent loop, memory, session, secrets, channels (Telegram), LLM transport, intervals.icu client (shared tools), setup wizard, runBinary entry-point, updater. Owns no sport vocabulary. Publishes the `Sport` and `BinaryConfig` contracts.
- [Cycling](./packages/sport-cycling/CONTEXT.md) — FTP-based zones, power-prescribed workouts, bike equipment, cyclist persona. Implements `Sport`. Bundled into the `cycling-coach` binary.
- [Running](./packages/sport-running/CONTEXT.md) — VDOT/pace-based zones, impact-aware progression, injury-first intake, runner persona. Stub.
- [Duathlon](./packages/sport-duathlon/CONTEXT.md) — coordinator context. Brick workouts, transitions, dual periodization. Stub.
- [Cycling Coach](./packages/cycling-coach/CONTEXT.md) — published `cycling-coach` binary; 7-line shim wiring cyclingSport + cyclingBinary into Core's runBinary.
- [Running Coach](./packages/running-coach/CONTEXT.md) — `running-coach` binary stub; placeholder banner.
- [Duathlon Coach](./packages/duathlon-coach/CONTEXT.md) — `duathlon-coach` binary stub; placeholder banner.

## Relationships

- **Core → Cycling, Running, Duathlon**: **Open Host Service**. Core publishes the `Sport` interface; each sport conforms. Core changes are coordinated across all sports.
- **Cycling ↔ Running**: **Partnership**. Peer contexts that evolve in lockstep when the `Sport` interface or shared infrastructure changes. Neither is upstream of the other.
- **Duathlon → Cycling, Running**: **Customer/Supplier (Conformist flavor)**. Duathlon imports `sport-cycling` and `sport-running` as workspace dependencies, reuses their tools/personas/zones verbatim, and adds duathlon-only concepts (brick, transition, dual periodization). Duathlon never redefines cycling or running vocabulary.

## Why Duathlon is a Customer, not a peer

1. **It doesn't redefine upstream vocabulary.** "FTP" means the same thing inside Duathlon as inside Cycling. If a duathlete asks about FTP, Cycling's persona answers verbatim.
2. **It adds, never overrides.** Brick, transition, dual periodization are _new_ concepts that don't exist in Cycling or Running.

If sport-cycling improves its FTP-test guidance, sport-duathlon inherits the improvement automatically. This is the load-bearing reason for the Customer pattern over Partnership.

## Status

Current state of the Core/Sport seam:

- **Core** — implemented at `packages/core/`. Sport-agnostic; no cycling vocabulary leaks. Three-category tool split per ADR-0004 (Pure-Core memory + intervals tools live in Core; sport-injected config flows in via `BinaryConfig`/`Sport.intervalsActivityTypes`). Private workspace package (`@enduragent/core`); bundled into the `cycling-coach` binary at publish time, not separately published. See ADR-0009.
- **Cycling** — implemented at `packages/sport-cycling/`. SOUL.md + skills/\*.md inlined into the bundle via tsup `.md: text` loader and skills.generated.ts codegen. Private workspace package (`@enduragent/sport-cycling`); bundled into the `cycling-coach` binary at publish time, not separately published.
- **Cycling Coach** — implemented at `packages/cycling-coach/`. 7-line bin shim. Published as `cycling-coach` on npm (CalVer continues). The published tarball is self-contained — `@enduragent/*` workspace code is inlined via `tsup` `noExternal`.
- **Running, Duathlon, Running Coach, Duathlon Coach** — empty stubs at `packages/{sport-running,sport-duathlon,running-coach,duathlon-coach}/`. Private workspace packages (SemVer); not published. They graduate to public CalVer-versioned npm binaries once a real implementation lands.

## Release flow

Changesets-driven, tag-triggered release split:

1. **`version-pr.yml`** opens or updates the bot-managed "Version Packages" PR. When that PR is merged, it tags and dispatches only public packages whose versions changed; a changed desktop app is independently tagged as `enduragent-desktop@<SemVer>`, given a draft release bound to the exact commit and desktop changelog, and dispatched to `desktop-release.yml`.
2. **`release.yml`** handles npm packages only. It gates on build + test + smoke-install, publishes via OIDC trusted publisher, and creates a non-latest GitHub Release so package releases cannot replace the desktop updater feed.
3. **`desktop-release.yml`** signs and notarizes on macOS, independently verifies the signed updater envelope, publishes the exact four updater assets to the bound draft, promotes it to repository latest, and confirms the production feed serves the new version.
4. **`desktop-windows-release.yml`** is the separate `workflow_dispatch` workflow for appending verified Windows assets to an existing published desktop release. The operator uploads the assets before it runs; the workflow verifies them and records the result as the `Enduragent-<version>-x64-verification.json` release asset without changing the release body, and it never gates `desktop-release.yml`.

Currently only `cycling-coach` is npm-publishable (per ADR-0009). The private desktop app follows its own SemVer and release transaction; changing it never changes or publishes `cycling-coach`. See `CONTRIBUTING.md` for the contributor-side steps.
