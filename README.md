# Cycling Coach

AI cycling coaching agent. Bring your own LLM API key, connect [intervals.icu](https://intervals.icu) for real athlete data, chat via Telegram or CLI.

## What it does

- Analyzes fitness, fatigue, and form from your real rides
- Builds periodized plans toward your goal event
- Pushes structured workouts to your intervals.icu calendar (auto-syncs to Garmin, Wahoo, Hammerhead, COROS, Suunto, Zwift)

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

## Quick start

Requires [Node.js](https://nodejs.org/) 20+ (comes with npm).

Open **Terminal** (Mac/Linux) or **PowerShell** (Windows) and run:

```bash
npm install -g cycling-coach
cycling-coach setup
cycling-coach
```

The setup wizard asks for your LLM API key and optionally connects [intervals.icu](https://intervals.icu) and Telegram. After setup, `cycling-coach` starts in CLI mode — or Telegram mode if you provided a bot token.

```
Cycling Coach (CLI mode). Type your message:
> Calculate my zones for FTP 280
> Build me a 12-week plan for a gran fondo
> What should I do today?
> /quit
```

**LLM provider options:**
- **Anthropic (Claude)** — console API key from [Anthropic Console](https://console.anthropic.com/). Recommended default.
- **OpenAI (GPT)** — console API key from [OpenAI Platform](https://platform.openai.com/).
- **Google (Gemini)** — console API key from [Google AI Studio](https://aistudio.google.com/).
- **OpenAI Codex (ChatGPT subscription) — experimental** — browser OAuth sign-in with your ChatGPT Plus / Pro / Business / Edu / Enterprise account. No API key needed; uses your subscription quota. Minimum tier: ChatGPT Plus ($20/mo). Select it in `cycling-coach setup` to start the OAuth flow. On hard rate-limit failures the bot retries up to 4× with backoff (~35s total) before reporting the error to the chat.

Anthropic's Claude Pro/Max subscription does **not** support OAuth for third-party tools (per Anthropic ToS) — the only supported Anthropic path here is the console API key.

**Where to get other keys:**
- **intervals.icu**: [intervals.icu/settings](https://intervals.icu/settings) > Developer Settings
- **Telegram**: Message [@BotFather](https://t.me/BotFather) > `/newbot`

### From source (development)

```bash
git clone git@github.com:yerzhansa/cycling-coach.git
cd cycling-coach

npm install
npm run build

# Dev loop (auto-reload, reads .env)
npm run dev
```

Note: `npm run dev` runs TypeScript directly (via tsx). `npm run build` produces `dist/` for running via Node / the published npm package.

## Telegram commands

| Command | What it does |
|---------|-------------|
| `/start` | Welcome message + available commands |
| `/plan` | Fetches your intervals.icu data, builds a periodized plan, asks to push to calendar |
| `/workout` | Checks your current fitness, fatigue, and form — suggests today's workout with structured intervals |
| `/status` | Shows fitness, fatigue, form, and coaching notes |
| `/sync` | Pushes next 1-2 weeks of planned workouts to intervals.icu calendar |

Free-form chat works too — ask anything about training, report an injury, request plan adjustments.

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

## Alternative config: YAML

Instead of env vars, you can create `~/.cycling-coach/config.yaml`:

```yaml
llm:
  provider: anthropic
  model: claude-opus-4-6
  api_key: sk-ant-...

intervals:
  api_key: your-intervals-api-key
  athlete_id: "0"

telegram:
  bot_token: "123456:ABC..."
```

For the Codex OAuth path, the config has no `api_key` — tokens live in `~/.cycling-coach/auth-profiles.json` (mode `0600`) and rotate automatically:

```yaml
llm:
  provider: openai-codex
  model: gpt-5.4
  auth_profile: openai-codex
```

Env vars take precedence over YAML.

## Development

```bash
npm run check       # tsc --noEmit + oxlint
npm test            # vitest (28 tests)
npm run test:watch  # vitest watch mode
npm run lint        # oxlint
npm run fmt         # oxfmt
npm run build       # tsc → dist/
```

## Project structure

```
src/
  cycling/           # Pure domain logic (extracted from training-app)
    schemas.ts       # Zod schemas + types
    zones.ts         # calculateCyclingZones(ftp)
    periodization.ts # Model selection, phases, volume tiers
    plan-builder.ts  # buildPlanSkeleton(profile)
    feasibility.ts   # FTP/W:kg goal assessment
    templates.ts     # Sample week builder
  agent/
    core.ts          # CyclingCoachAgent (Vercel AI SDK v6)
    tools.ts         # 12 tool definitions
    system-prompt.ts # SOUL + skills + memory → system prompt
    memory.ts        # File-based memory system
  channels/
    telegram.ts      # grammY bot
  config.ts          # Config loader (env + yaml)
  index.ts           # Entry point
skills/              # Markdown domain knowledge (loaded into system prompt)
SOUL.md              # Coaching persona
tests/               # 28 tests
```

## Tech stack

| Dependency | Version | Purpose |
|-----------|---------|---------|
| [Vercel AI SDK](https://sdk.vercel.ai/) | 6.x | Model-agnostic LLM interface with tool calling |
| [intervals-icu-api](https://github.com/yerzhansa/intervals-icu-api) | local | TypeScript client for intervals.icu |
| [grammY](https://grammy.dev/) | 1.x | Telegram bot framework |
| [Zod](https://zod.dev/) | 4.x | Schema validation |
| [oxlint](https://oxc.rs/) | 1.x | Linter |
| [oxfmt](https://oxc.rs/) | 0.x | Formatter |
| [TypeScript](https://www.typescriptlang.org/) | 6.x | |
| [Vitest](https://vitest.dev/) | 4.x | Testing |

## License

MIT
