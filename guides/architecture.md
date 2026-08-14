# Architecture

## How it works

```
┌─────────────────────────────────────────────────────────┐
│                          You                            │
│                    Telegram / CLI                       │
└────────────────────────────┬────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────┐
│                  Cycling Coach Agent                    │
│                                                         │
│  ┌──────────────┐  ┌─────────────┐  ┌───────────────┐   │
│  │ Coaching     │  │ Cycling     │  │ Memory        │   │
│  │ persona &    │  │ logic       │  │ goals, notes, │   │
│  │ domain skills│  │ zones, plans│  │ preferences   │   │
│  └──────────────┘  └─────────────┘  └───────────────┘   │
│                                                         │
│  ┌──────────────────────────────────────────────────┐   │
│  │                Intervals.icu API                 │   │
│  │ fitness · fatigue · form · rides · push workouts │   │
│  └──────────────────────────────────────────────────┘   │
└────────────────────────────┬────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────┐
│             LLM  (Claude / GPT / Gemini)                │
│      Interprets data + coaching knowledge → response    │
└─────────────────────────────────────────────────────────┘
```

1. **You send a message** — via Telegram or the command line ("Build me a 12-week gran fondo plan", "What should I ride today?")
2. **The coach reads your history** — goals, past conversations, injury notes, and preferences stored locally on your machine
3. **It pulls your real data** — current fitness, fatigue, form, recent rides, FTP, and zones from intervals.icu
4. **It runs cycling logic** — zone calculations, periodization models, feasibility checks, workout structure — all deterministic, no guessing
5. **An LLM puts it together** — Claude, GPT, or Gemini interprets everything and responds like a knowledgeable coach
6. **Workouts land on your calendar** — structured intervals pushed to intervals.icu, which syncs to Garmin, Wahoo, Hammerhead, COROS, Suunto, and Zwift

## What the agent can do

### Cycling logic (runs locally, no API calls)

- **Zone calculator** — 6 power zones from FTP (Z1 Recovery through Z6 VO2max)
- **Plan builder** — periodized training plan from athlete profile (linear, block, reverse linear, polarized, pyramidal models)
- **Feasibility check** — assesses whether FTP or W/kg targets are realistic
- **Sample weeks** — generates weekly workout templates by volume tier with hard session spacing

### intervals.icu integration

- Fetch athlete profile (FTP, weight, max HR, zones)
- Fetch recent activities (load, intensity, duration)
- Fetch wellness data (fitness, fatigue, form, HRV, resting HR, sleep)
- Push workouts to calendar → auto-syncs to Garmin, Wahoo, Hammerhead, COROS, Suunto, and Zwift

### Memory

File-based at `~/.cycling-coach/`:
- `memory/MEMORY.md` — long-term: goals, injury history, preferences
- `memory/2026-04-13.md` — daily conversation notes
- `plans/current-plan.json` — active training plan

The agent reads memory at the start of each conversation and writes to it when significant decisions are made (new goal, plan change, injury).

Conversation transcripts live at `~/.cycling-coach/sessions/<chatId>.jsonl`. A session reset renames the transcript to a timestamped archive (`<chatId>.jsonl.reset.<timestamp>`) rather than deleting it, and archives are kept indefinitely by default. To opt into age-based cleanup, set `session.resetArchiveRetentionDays` in `config.yaml` (or the `SESSION_RESET_ARCHIVE_RETENTION_DAYS` env var) to the number of days to keep archives; `0` — the default — keeps them forever. Archive files are owner-readable only (mode `0600`).

## Repository layout

A monorepo. Sport-agnostic infrastructure lives in `core`; each sport implements the Sport contract
it publishes; the desktop app and the CLI are front ends over the same engine.

```
packages/
  core/                # Sport-agnostic infrastructure: agent loop, memory, secrets,
                       # channels, LLM, intervals.icu. Publishes the Sport contract.
  kernel/              # Portable compute, store and Reference kernel; I/O via injected ports
  kernel-node/         # Node host adapter for the kernel (node:sqlite / node:fs / WebCrypto)
  engine/              # Coaching engine boundary and sport contract
  coach/               # Node composition root for Reference-layer sync orchestration
  coach-contract/      # Engine/UI seam: CoachEngine interface, schemas, TurnEvent, exit codes
  coach-client/        # WebSocket client for the coaching contract
  coach-cli/           # Terminal surface
  sport-cycling/       # Cycling: soul, skills, tools, schemas
  sport-running/       # Running: critical-speed-anchored pace zones, soul, skills, tools
  sport-duathlon/      # Duathlon coordinator (alpha)
  sync-intervals-icu/  # Archive-first intervals.icu source for the Reference layer
  sync-file-import/    # File source (.fit / .tcx / .gpx) for the Reference layer
  cycling-coach/       # The published npm package and CLI binary
  running-coach/       # Running agent package
  duathlon-coach/      # Duathlon agent package (alpha)
apps/
  desktop/             # Electron main process
  desktop-renderer/    # Desktop UI
skills/                # Markdown domain knowledge, loaded into the system prompt
SOUL.md                # Coaching persona
```

## Development

```bash
npm run check       # tsc --noEmit + oxlint
npm test            # vitest (112 tests)
npm run test:watch  # vitest watch mode
npm run lint        # oxlint
npm run fmt         # oxfmt
npm run build       # tsc → dist/
```

### Separating dev from prod

Set `CYCLING_COACH_HOME` to isolate `npm run dev` from the globally-installed
`cycling-coach` CLI. Each dir has its own `config.yaml`, `auth-profiles.json`,
`sessions/`, and `memory/`, so dev and prod never collide:

```bash
# .env (loaded only by `npm run dev`)
CYCLING_COACH_HOME=~/.cycling-coach-dev
```

The global install keeps using `~/.cycling-coach`. For full isolation, run
`npm run setup` once against the dev home to register a separate Telegram bot
token and (recommended) a separate intervals.icu athlete.

## Tech stack

| Dependency | Version | Purpose |
|-----------|---------|---------|
| [Vercel AI SDK](https://sdk.vercel.ai/) | 6.x | Model-agnostic LLM interface with tool calling |
| [intervals-icu-api](https://github.com/yerzhansa/intervals-icu-api) | local | TypeScript client for intervals.icu |
| [grammY](https://grammy.dev/) | 1.x | Telegram bot framework |
| [Zod](https://zod.dev/) | 4.x | Schema validation |
| [oxlint](https://oxc.rs/) | 1.x | Linter |
| [oxfmt](https://oxc.rs/) | 0.x | Formatter |
| [TypeScript](https://www.typescriptlang.org/) | 6.x | Type system |
| [Vitest](https://vitest.dev/) | 4.x | Testing |
