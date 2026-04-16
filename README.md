# Cycling Coach

AI-powered cycling coach you can chat with on Telegram or in the terminal. Connect your [intervals.icu](https://intervals.icu) account to pull real training data — the coach analyzes your fitness, builds periodized plans, and pushes structured workouts straight to your calendar (auto-syncs to Garmin, Wahoo, Hammerhead, COROS, Suunto, and Zwift).

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

## Setup

### 1. Install

**From npm** (recommended):

```bash
npm install -g cycling-coach
```

**From source:**

```bash
git clone git@github.com:yerzhansa/cycling-coach.git
cd cycling-coach
npm install
```

Both require **Node.js 20+** — download from [nodejs.org](https://nodejs.org/) (LTS version).

### 2. Configure API keys

Copy the example env file and fill in your keys:

```bash
cp .env.example .env
```

```bash
# .env

# Pick one LLM provider
ANTHROPIC_API_KEY=sk-ant-...
# OPENAI_API_KEY=sk-...
# GOOGLE_GENERATIVE_AI_API_KEY=...

LLM_PROVIDER=anthropic           # anthropic | openai | google
LLM_MODEL=claude-opus-4-6   # optional, defaults per provider

# intervals.icu (optional — agent works without it, just no real data)
INTERVALS_API_KEY=your-key        # Settings > Developer in intervals.icu
INTERVALS_ATHLETE_ID=0            # "0" = authenticated athlete

# Telegram (optional — omit for CLI mode)
TELEGRAM_BOT_TOKEN=123456:ABC...  # from @BotFather
```

**Where to get keys:**
- **LLM**: [Anthropic Console](https://console.anthropic.com/), [OpenAI Platform](https://platform.openai.com/), or [Google AI Studio](https://aistudio.google.com/)
- **intervals.icu**: Go to [intervals.icu/settings](https://intervals.icu/settings) > Developer Settings > copy your API Key and Athlete ID (shown right next to each other)
- **Telegram**: Message [@BotFather](https://t.me/BotFather) on Telegram, `/newbot`, follow prompts

### 3. Run

**CLI mode** (no Telegram token set):

```bash
npx cycling-coach      # if installed from npm
npm run dev            # if running from source
```

```
Cycling Coach (CLI mode). Type your message:
> Calculate my zones for FTP 280
> Build me a 12-week plan for a gran fondo
> What should I do today?
> /quit
```

**Telegram mode** (with `TELEGRAM_BOT_TOKEN` set):

```bash
npx cycling-coach      # if installed from npm
npm run dev            # if running from source
```

The bot starts polling. Open your bot in Telegram and send `/start`.

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
