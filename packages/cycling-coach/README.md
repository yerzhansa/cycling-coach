# Cycling Coach

AI cycling coaching agent. Bring your own LLM API key **or sign in with a ChatGPT Plus subscription**, connect [intervals.icu](https://intervals.icu) for real athlete data, chat via Telegram or CLI.

## Install

Requires [Node.js](https://nodejs.org/) 22+.

```bash
npm install -g cycling-coach
cycling-coach setup
cycling-coach
```

The setup wizard asks for your LLM provider — an API key for Anthropic / OpenAI / Google, **or OAuth sign-in with your ChatGPT subscription** (no API key needed). Then optionally connects [intervals.icu](https://intervals.icu) and Telegram. After setup, `cycling-coach` starts in CLI mode — or Telegram mode if you provided a bot token.

```
Cycling Coach (CLI mode). Type your message:
> Create a 2-hour Z2 ride with sprints
> Create 3x15 min sweet spot intervals
> Create VO2max intervals
> Review my last ride
> Build me a 12-week plan for a gran fondo
> What should I do today?
```

## What it does

- Analyzes fitness, fatigue, and form from your real rides
- Builds periodized plans toward your goal event
- Pushes structured workouts to your intervals.icu calendar (auto-syncs to Garmin, Wahoo, Hammerhead, COROS, Suunto, Zwift)

## LLM provider options

- **Anthropic (Claude)** — API key from [Anthropic Console](https://console.anthropic.com/). Recommended default.
- **OpenAI (GPT)** — API key from [OpenAI Platform](https://platform.openai.com/).
- **Google (Gemini)** — API key from [Google AI Studio](https://aistudio.google.com/).
- **ChatGPT subscription (experimental)** — browser OAuth sign-in with your ChatGPT Plus / Pro / Business / Edu / Enterprise account. No API key; uses your subscription quota. Models: `gpt-5.4` (recommended) and `gpt-5.4-mini` (faster, smaller context). Cost is covered by the subscription regardless of which model you pick.

Anthropic's Claude Pro/Max subscription does **not** support OAuth for third-party tools — the only supported Anthropic path is the console API key.

## Optional integrations

- **intervals.icu** API key from [intervals.icu/settings](https://intervals.icu/settings) > Developer Settings.
- **Telegram bot** token from [@BotFather](https://t.me/BotFather) (`/newbot`).

## Telegram commands

| Command | What it does |
|---------|-------------|
| `/start` | Welcome message + available commands |
| `/plan` | Builds a periodized plan, asks to push to calendar |
| `/workout` | Suggests today's workout from current fitness, fatigue, and form |
| `/status` | Shows fitness, fatigue, form, and coaching notes |
| `/sync` | Pushes next 1-2 weeks of planned workouts to intervals.icu |

Free-form chat works too — ask anything about training, report an injury, request plan adjustments.

## Where state lives

`~/.cycling-coach/` (override with `CYCLING_COACH_HOME`):

- `config.yaml` — provider/model selection (env vars take precedence)
- `auth-profiles.json` — OAuth tokens (mode `0600`, rotated automatically)
- `memory/MEMORY.md` — long-term: goals, injury history, preferences
- `memory/YYYY-MM-DD.md` — daily conversation notes
- `plans/current-plan.json` — active training plan
- `sessions/<chatId>.jsonl` — per-chat history

The agent reads memory at the start of each conversation and writes to it when significant decisions are made (new goal, plan change, injury).

## Troubleshooting

**`cycling-coach: command not found`** — if you installed without the `-g` flag, the binary isn't on your `$PATH`. Either re-install globally (`npm install -g cycling-coach`), or run it via `npx`:

```bash
npx cycling-coach setup
npx cycling-coach
```

`npx` ships with Node.js, so no extra install step is needed.

## More

- Follow [@yerzhansa](https://x.com/yerzhansa) on X for updates, or drop a question/feedback anytime.
- **Secrets backends** (1Password, macOS Keychain, Vault, AWS/GCP Secret Manager, age, env), **architecture diagram**, and **development setup** — see the [GitHub repo](https://github.com/yerzhansa/cycling-coach#readme).
- **Issues**: <https://github.com/yerzhansa/cycling-coach/issues>
- **License**: MIT
