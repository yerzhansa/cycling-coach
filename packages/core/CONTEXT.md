# Core

Sport-agnostic infrastructure for AI coaching agents. Provides the agent loop, memory, secrets, channels, LLM transport, and intervals.icu client. Publishes the `Sport` contract that domain packages implement.

> Status: this directory is a planning placeholder. Source still lives at the repo root in `src/agent/`, `src/secrets/`, `src/auth/`, `src/channels/`. The refactor will move that code here.

## Language

**Sport**:
A pluggable coaching domain (cycling, running, duathlon) that conforms to Core's `Sport` interface — pure domain knowledge, no deployment concerns.
_Avoid_: Discipline, modality, mode

**Binary**:
A deployed CLI executable wrapping a `Sport` with deployment-shell config (npm name, display name, data subdir, keychain prefix). Multiple binaries can share one Sport.
_Avoid_: Build, distro, app

**Agent**:
The Core-owned conversation loop that runs LLM calls with tool dispatch, compaction, and memory flush; sport-agnostic.

**Memory**:
A file-backed sectioned store of long-lived athlete information at `~/.enduragent/<binary>/memory/MEMORY.md` (or legacy `~/.cycling-coach/memory/MEMORY.md` for grandfathered cycling-coach users).

**Memory Section**:
A named bucket within `Memory`. Each section is owned by exactly one declarer: Core (shared across all sports) or a Sport (sport-specific, prefixed with sport id).

**Core Shared Sections**:
The six sections Core auto-injects for every binary regardless of sport: `person`, `schedule`, `goals`, `preferences`, `notes`, `medical-history`. Universal across endurance athletes; Sport packages do not redeclare them.

**Sport Sections**:
Sport-specific sections declared by a Sport package, with the sport id as prefix (e.g., `cycling-profile`, `running-history`, `duathlon-calendar`). Imported verbatim by Customer contexts — Duathlon's section list includes Cycling's and Running's sections without modification.

**Must-Preserve Tokens**:
Per-Sport list of literal phrases the LLM is forbidden to drop during compaction (e.g., `FTP`, `VDOT`).

**CoreDeps**:
The runtime services Core supplies to a Sport's tool factory: `LLM`, `IntervalsClient`, `MemoryStore`, `SecretsResolver`.

**Session**:
One user's chat state with one Binary, persisted to disk and locked against concurrent processes.

**Channel**:
A delivery surface (currently only Telegram); sport-agnostic.

## Relationships

- A **Binary** wraps exactly one **Sport** plus deployment config.
- An **Agent** is constructed with one **Sport**; never switches mid-session.
- A **Sport** declares its **Memory Sections** and **Must-Preserve Tokens**; Core consumes both.
- A **Sport**'s `tools` factory receives **CoreDeps** and returns tool registrations the **Agent** dispatches.
- One **Binary** owns one **Memory** file.

## Example dialogue

> **Dev:** "When the duathlete asks about FTP, does the duathlon **Sport** answer or delegate to cycling?"
> **Domain expert:** "There's only one active **Sport** per **Agent**. Duathlon's `soul` and `tools` are *composed* from cycling and running at construction time. From Core's view, one **Sport** answers."

## Flagged ambiguities

- "Coach" was used to mean both **Sport** (coaching domain) and **Binary** (CLI executable). Resolved: code uses **Sport** for domain, **Binary** for deployment shell. "Coach" remains in product surfaces (display names, READMEs) but is not a code-level term.
