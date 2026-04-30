# Context Map

This repo is being refactored from a single-package `cycling-coach` into a multi-context monorepo. Four bounded contexts are committed; see [`docs/architect-review/multi-sport-architecture.md`](./docs/architect-review/multi-sport-architecture.md) for the full architecture.

## Contexts

- [Core](./packages/core/CONTEXT.md) — sport-agnostic infrastructure: agent loop, memory, session, secrets, channels (Telegram), LLM transport, intervals.icu client, setup wizard, updater. Owns no sport vocabulary. Publishes the `Sport` interface.
- [Cycling](./packages/sport-cycling/CONTEXT.md) — FTP-based zones, power-prescribed workouts, bike equipment, cyclist persona. Ships as `cycling-coach` binary.
- [Running](./packages/sport-running/CONTEXT.md) — VDOT/pace-based zones, impact-aware progression, injury-first intake, runner persona. Ships as `running-coach` binary.
- [Duathlon](./packages/sport-duathlon/CONTEXT.md) — coordinator context. Brick workouts, transitions, dual periodization. Ships as `duathlon-coach` binary.

## Relationships

- **Core → Cycling, Running, Duathlon**: **Open Host Service**. Core publishes the `Sport` interface; each sport conforms. Core changes are coordinated across all sports.
- **Cycling ↔ Running**: **Partnership**. Peer contexts that evolve in lockstep when the `Sport` interface or shared infrastructure changes. Neither is upstream of the other.
- **Duathlon → Cycling, Running**: **Customer/Supplier (Conformist flavor)**. Duathlon imports `sport-cycling` and `sport-running` as workspace dependencies, reuses their tools/personas/zones verbatim, and adds duathlon-only concepts (brick, transition, dual periodization). Duathlon never redefines cycling or running vocabulary.

## Why Duathlon is a Customer, not a peer

1. **It doesn't redefine upstream vocabulary.** "FTP" means the same thing inside Duathlon as inside Cycling. If a duathlete asks about FTP, Cycling's persona answers verbatim.
2. **It adds, never overrides.** Brick, transition, dual periodization are *new* concepts that don't exist in Cycling or Running.

If sport-cycling improves its FTP-test guidance, sport-duathlon inherits the improvement automatically. This is the load-bearing reason for the Customer pattern over Partnership.

## Status

- **Cycling** — implemented (`src/cycling/`, `src/agent/`, `SOUL.md`, `skills/*.md`). Package boundary not yet enforced.
- **Running** — not started. Built after Cycling is refactored into monorepo layout.
- **Duathlon** — not started. Built after Running ships standalone (the architect-recommended sequence).
- **Core** — implicitly exists across `src/agent/`, `src/secrets/`, `src/auth/`, `src/channels/`, but has cycling vocabulary leaks at `src/agent/compaction.ts:34-46` and `src/agent/memory-flush.ts:28-34` that the refactor will resolve.
