# Cycling Coach

AI cycling coaching agent. Bring your own LLM API key **or sign in with a ChatGPT Plus subscription**, connect [intervals.icu](https://intervals.icu) for real athlete data, chat via Telegram or CLI.

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

The setup wizard asks for your LLM provider — an API key for Anthropic / OpenAI / Google, **or OAuth sign-in with your ChatGPT subscription** (no API key needed). Then optionally connects [intervals.icu](https://intervals.icu) and Telegram. After setup, `cycling-coach` starts in CLI mode — or Telegram mode if you provided a bot token.

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
- **OpenAI Codex (ChatGPT subscription) — experimental** — browser OAuth sign-in with your ChatGPT Plus / Pro / Business / Edu / Enterprise account. No API key needed; the bot uses your subscription quota. Minimum tier: ChatGPT Plus ($20/mo). Select it in `cycling-coach setup` to start the OAuth flow. Models offered in the wizard: `gpt-5.4` (balanced, recommended) and `gpt-5.4-mini` (faster, smaller context). Cost is covered by the subscription regardless of which model you pick — the choice is speed vs capability, not price. On hard rate-limit failures the bot retries up to 4× with backoff (~35s total) before reporting the error to the chat.

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

## Storing secrets outside config.yaml

If you don't want API keys to live as plaintext in `~/.cycling-coach/config.yaml`, any secret field (`llm.api_key`, `intervals.api_key`, `telegram.bot_token`) can be replaced with a **SecretRef** — a reference to an external command that prints the secret to stdout. Cycling Coach runs the command at startup, reads stdout, and uses the value.

```yaml
llm:
  provider: anthropic
  model: claude-sonnet-4-6
  api_key:
    source: exec
    command: op
    args: [read, "op://Personal/Anthropic/credential"]
```

**Precedence**: env var > SecretRef > plain YAML. Setting `ANTHROPIC_API_KEY` in your shell still wins — useful for debugging a vault issue without touching YAML.

**Requirements**:
- The `command` must print **only the secret** to stdout. JSON blobs, labels, or extra output will be stored verbatim and downstream APIs will reject them.
- A single trailing `\n` or `\r\n` is trimmed; all other whitespace is preserved.
- Empty output, non-zero exit, a 30s timeout, or output over 64KB is a fatal startup error with a clear stderr message.
- `shell: false` — `command` and `args` are passed directly to the OS. `~`, `$HOME`, globs, and shell operators are **not** expanded. Use absolute paths.

### Using the setup wizard with a password manager

If you have the [1Password CLI (`op`)](https://developer.1password.com/docs/cli/) or you're on macOS, `cycling-coach setup` can create the backend items for you — no YAML hand-editing, no manual `op item create` / `security add-generic-password` calls.

When the wizard reaches the secrets step it asks **"Where to store secrets?"**. The available options depend on what it detects:

- **Plain config.yaml** — the pre-existing behavior; secrets are written as plain strings.
- **1Password CLI** — offered when `op` is on your `$PATH`. If `op` is installed but not signed in, the wizard offers an **"1Password CLI — sign in first"** option that runs `op signin` inline, then re-detects and continues. If no account is configured, the option is hidden and an INFO log explains why.
- **macOS Keychain** — offered on macOS (Darwin) only.

Pick one and the wizard handles every subsequent secret prompt (`llm.api_key`, `intervals.api_key`, `telegram.bot_token`) against that backend. For 1Password, the first write triggers Touch ID / system auth. The resulting `config.yaml` stores only a SecretRef pointing at the backend — your actual secret value never lands in YAML.

**Re-running the wizard is idempotent.** Hit Enter at any password prompt to keep the existing value; YAML is unchanged and no new backend item is created. If a 1Password item with the same title already exists, the wizard prompts `[Update | Keep existing | Cancel]` instead of overwriting blindly.

**Switching backends on a re-run** (e.g. you picked Keychain last time, now want 1Password): if you type a new value, the wizard writes to the new backend and leaves the old item alone — the old SecretRef is replaced in YAML but the old Keychain/1Password item is not deleted (clean it up manually if you want). If you hit Enter without typing a new value, the wizard shows an explicit `[Paste to migrate to <new backend> | Keep in <old backend> (YAML unchanged)]` prompt — it never silently reads a secret from one backend and writes it to another.

> **Pasted keys are trimmed.** The wizard strips leading and trailing whitespace from pasted secrets and logs `Trimmed whitespace from pasted <field>.` at INFO when it does. This catches trailing newlines that clipboard managers commonly add (a frequent cause of "key works in curl, fails in the bot"). If your secret legitimately needs surrounding whitespace — rare, but real for some token formats — set it via env var instead; the env-var path bypasses trim.

> **Run setup from one terminal at a time.** Concurrent `cycling-coach setup` runs may create duplicate backend items or race on the YAML write; the wizard does not lock against this in v1. If you accidentally start two, complete one and re-run the other — the re-run UX (Update / Keep / Cancel) handles duplicates cleanly.

> **Keychain scope (macOS).** The Keychain backend uses your **login keychain** (per-Mac, unlocked automatically when you log in, not synced via iCloud). The full keychain path is pinned in the SecretRef so a later `security default-keychain -s …` won't silently break cycling-coach. If you want cross-device sync, pick **1Password** in the wizard instead. Custom keychains and iCloud Keychain targeting are planned for v2.

> **Ctrl+C during a "1Password: creating item…" step may leave orphans.** The wizard tracks items it creates in-run and prints `op item delete "…"` cleanup commands on cancellation (Ctrl+C, SIGTERM). There is an unclosable sub-second race where `op` commits the new item server-side but the child is killed before it can report success — the wizard has no way to record it, so it can't list it for cleanup. After a forced cancel, run `op item list | grep cycling-coach` to check for stray items. This is a fundamental limitation of child-process write-then-ack semantics, not specific to cycling-coach.

**Non-TTY invocations are rejected.** Running `cycling-coach setup` from a non-interactive context (CI, Docker build, `systemd` post-install, piped stdin) exits with code 2 and a stderr pointer to the [Non-interactive setup](#non-interactive-setup-ci--docker--launchd) section below. Zero side effects are performed before the TTY check.

### Backend compatibility matrix

| Backend | `command` | `args` | Caveat |
|---|---|---|---|
| 1Password CLI | `op` | `["read", "op://Vault/Item/field"]` | GUI session required for Touch ID; not for headless/launchd. |
| macOS Keychain | `security` | `["find-generic-password", "-w", "-s", "cycling-coach", "-a", "anthropic_api_key", "/Users/you/Library/Keychains/login.keychain-db"]` | `-w` is mandatory — without it the whole record is dumped. The keychain path is passed as the **last positional argument** (pins the keychain so a later `security default-keychain -s …` doesn't break cycling-coach). macOS's `security` does not support a `-k` flag on `*-generic-password` subcommands. |
| Bitwarden | `bw` | `["get", "password", "anthropic-api-key"]` | Requires `BW_SESSION` env from `bw unlock` before cycling-coach starts. |
| HashiCorp Vault | `vault` | `["kv", "get", "-field=key", "secret/anthropic"]` | `-field=` is mandatory — raw `vault kv get` prints JSON. Needs `VAULT_ADDR` + `VAULT_TOKEN`. |
| AWS Secrets Manager | `aws` | `["secretsmanager", "get-secret-value", "--secret-id", "my/secret", "--query", "SecretString", "--output", "text"]` | `--query SecretString --output text` is mandatory. Without both flags the output is JSON and the bot fails with "invalid API key". |
| GCP Secret Manager | `gcloud` | `["secrets", "versions", "access", "latest", "--secret=anthropic"]` | Requires `gcloud auth application-default login` in the environment cycling-coach runs under. |
| age-encrypted file | `age` | `["-d", "-i", "/Users/you/.age/key.txt", "/Users/you/secrets/anthropic.age"]` | **Absolute paths only** — `shell: false` does not expand `~` or `$HOME`. |

### launchd / systemd / Docker (headless daemons)

- Use **absolute paths** in `command:` — macOS `launchd` starts processes with a minimal `PATH` that excludes `/usr/local/bin` and Homebrew paths. Put `/usr/local/bin/op` (the output of `which op`) instead of bare `op`.
- **1Password Touch ID won't work headless** — no GUI to prompt against. For daemon use, pick a backend with a pre-unlocked session (Vault, cloud secret managers, `age`-encrypted files), or supply the key via env var.
- Stderr from the resolver command is shown on non-zero exit (last 200 chars). Stick to well-behaved CLIs — a buggy resolver that prints the secret on error will leak it to logs.

### Non-interactive setup (CI / Docker / launchd)

If you can't run `cycling-coach setup` in an interactive terminal, hand-edit `~/.cycling-coach/config.yaml` directly. A minimal YAML with env-supplied secrets:

```yaml
llm:
  provider: anthropic
  model: claude-sonnet-4-6
# api_key, intervals, telegram sourced from env vars:
# ANTHROPIC_API_KEY, INTERVALS_API_KEY, INTERVALS_ATHLETE_ID, TELEGRAM_BOT_TOKEN
```

Or fully SecretRef-driven:

```yaml
llm:
  provider: anthropic
  model: claude-sonnet-4-6
  api_key:
    source: exec
    command: /usr/local/bin/op
    args: [read, "op://Personal/Anthropic/credential"]

intervals:
  api_key:
    source: exec
    command: /usr/local/bin/vault
    args: [kv, get, -field=key, secret/intervals]
  athlete_id: "i12345"

telegram:
  bot_token:
    source: exec
    command: /usr/bin/security
    args: [find-generic-password, -w, -s, cycling-coach, -a, telegram_bot_token, /Users/you/Library/Keychains/login.keychain-db]
```

### Downgrading

SecretRef support was added in a recent release. Downgrading cycling-coach while `config.yaml` contains SecretRef blocks will fail at startup — older versions treat non-string secret values as malformed. Keep plain strings or env vars if you need to roll back.

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
tests/               # 112 tests
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
