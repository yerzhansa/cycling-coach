# Deploying the self-hosted bot

## Deploy in the cloud

Cycling Coach is a single Node process holding a long-polling connection to Telegram, with state on a local volume at `$CYCLING_COACH_HOME` (defaults to `~/.cycling-coach`). It needs:

- An always-on container or VM (no scale-to-zero — long-polling stops when the process stops).
- A persistent volume mounted at `/data` (or wherever you point `CYCLING_COACH_HOME`).
- Secrets injected as env vars, referenced from `config.yaml` via `source: env` (see [Storing secrets outside config.yaml](./configuration.md#storing-secrets-outside-configyaml)).
- One instance only — sessions are sharded by Telegram chat ID on local disk; do not enable autoscaling.
- A BYOK API-key provider (`anthropic` / `openai` / `google` / `deepseek` / `qwen` / `minimax` / `kimi` / `zai` / `openrouter`). `LLM_PROVIDER=openai-codex` is **not supported in containers** — it depends on an interactive OAuth flow that writes to the data dir, which can't run headless. `LLM_PROVIDER=claude-cli` is **not supported in containers** either — it requires a locally installed Claude Code CLI that you have signed into, which a headless image does not have. `LLM_PROVIDER=codex-agent` is **not supported in containers** for the same reason, and cannot be enabled by environment variable at all — it needs `llm.codex_agent.enabled: true` in `config.yaml`.

### Docker

The official image is published to GHCR:

```bash
docker pull ghcr.io/yerzhansa/cycling-coach:stable
```

Run it with a persistent `/data` volume:

```bash
docker run -d --name cycling-coach \
  -v cycling-coach-data:/data \
  --env-file .env \
  ghcr.io/yerzhansa/cycling-coach:stable
```

Or build the same image locally from this repo:

```bash
docker build -f packages/cycling-coach/Dockerfile -t cycling-coach .
```

Use `--env-file` rather than inline `-e KEY=value` flags — inline values land in shell history and are visible to other users via `ps`. Your `.env` should contain `LLM_PROVIDER`, `LLM_API_KEY`, `INTERVALS_API_KEY`, `INTERVALS_ATHLETE_ID`, `TELEGRAM_BOT_TOKEN`, and `CYCLING_COACH_OPERATOR_ID` for unattended cloud/container starts. Provider-specific LLM env vars still work and take precedence over `LLM_API_KEY`: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `DEEPSEEK_API_KEY`, `ALIBABA_API_KEY`, `MINIMAX_API_KEY`, `MOONSHOT_API_KEY`, `ZAI_API_KEY`, or `OPENROUTER_API_KEY`. Restrict the file to the user that invokes `docker`: `chmod 600 .env`. Note that env vars passed to a container remain visible via `docker inspect` to anything with Docker-socket access — where available, prefer Docker Compose `secrets:` or podman secrets instead. For non-container installs, the config-based secret backends (macOS Keychain, 1Password SecretRef — see [Storing secrets outside config.yaml](./configuration.md#storing-secrets-outside-configyaml)) keep keys out of the environment entirely.

The image mounts `/data` for state and reads `/data/config.yaml` if present. The image sets `CYCLING_COACH_MANAGED_DEPLOY=1`, so `/update` is disabled and updates happen by pulling/redeploying a newer image. The container starts as root only long enough to fix managed-platform volume ownership, then drops to the non-root `node` user (uid 1000). With the env vars above, no `config.yaml` is required — `LLM_PROVIDER` + `LLM_API_KEY` covers all API-key LLM providers.

For finer control (custom model, idle timeout, etc.) drop a `config.yaml` into the volume:

```yaml
# /data/config.yaml
llm:
  provider: anthropic
  model: claude-sonnet-4-6
  api_key:
    source: env
    var: LLM_API_KEY
intervals:
  api_key:
    source: env
    var: INTERVALS_API_KEY
  athlete_id: "i12345"
telegram:
  bot_token:
    source: env
    var: TELEGRAM_BOT_TOKEN
```

### Railway template

Railway templates are one-click deploy recipes. The Cycling Coach template runs your own private bot on Railway 24/7, so your computer does not need to stay on.

Deploy: https://railway.com/deploy/cycling-coach

Railway hosts the container and volume in your Railway account. The bot reads your Railway variables, talks to Telegram, intervals.icu, and your chosen LLM provider from inside your Railway project. We do not host a shared backend, store your secrets, store your athlete data, or receive your Telegram messages. Your hosting and billing relationship is with Railway. Railway currently lists Hobby as the practical minimum for always-on apps: $5 minimum usage/month, including $5 monthly usage credits.

The template uses `ghcr.io/yerzhansa/enduragent:stable`, mounts persistent state at `/data`, and has image auto-updates enabled.

Before you click **Deploy**, prepare three accounts: one LLM provider account, intervals.icu, and Telegram.

Fill these Railway variables:

| Variable | What to enter | Where to get it |
| --- | --- | --- |
| `LLM_PROVIDER` | One lower-case provider id: `anthropic`, `openai`, `google`, `deepseek`, `qwen`, `minimax`, `kimi`, `zai`, or `openrouter`. Start with `anthropic` if unsure. | Pick the provider that issued your `LLM_API_KEY`. ChatGPT Plus login is not supported in Railway because it needs an interactive browser login. `LLM_PROVIDER=claude-cli` is not supported on Railway either — it needs a locally signed-in Claude Code CLI, and neither is `codex-agent`, which additionally cannot be enabled by environment variable. |
| `LLM_API_KEY` | API key for the provider in `LLM_PROVIDER`. | [Anthropic Console](https://console.anthropic.com/), [OpenAI Platform](https://platform.openai.com/), [Google AI Studio](https://aistudio.google.com/), [DeepSeek Platform](https://platform.deepseek.com/), Alibaba Cloud DashScope, [MiniMax Platform](https://platform.minimaxi.com/), [Moonshot AI](https://platform.moonshot.ai/), [Z.AI](https://z.ai/), or [OpenRouter](https://openrouter.ai/). |
| `INTERVALS_API_KEY` | Your intervals.icu API key. | [intervals.icu/settings](https://intervals.icu/settings) > Developer Settings. |
| `INTERVALS_ATHLETE_ID` | Your intervals.icu athlete id, usually like `i12345`. Include the leading `i` when intervals.icu shows one. | Open your intervals.icu profile/settings URL and copy the athlete id from the URL or profile details. |
| `TELEGRAM_BOT_TOKEN` | Token for the Telegram bot users will message. | In Telegram, open [@BotFather](https://t.me/BotFather), run `/newbot`, choose a name and username, then copy the token. |
| `CYCLING_COACH_OPERATOR_ID` | Your numeric Telegram user id, for example `123456789`. This is not the bot token and not the bot username. | In Telegram, message a helper bot such as [@userinfobot](https://t.me/userinfobot) and copy your numeric id. Only this Telegram user is allowed to talk to your bot by default. |

Railway does not run `cycling-coach setup`; the variables above are the setup. After deploy, open Telegram and send `/start` to the bot you created with BotFather. If a value is wrong, edit the service variables in Railway and redeploy or restart the service.

### Other platforms

- **Fly.io** — works with the same Dockerfile. In `fly.toml` set `auto_stop_machines = false` and `min_machines_running = 1`, otherwise Fly will stop the machine on idle inbound HTTP and the bot stops polling. Mount a 1 GB volume at `/data`.
- **VPS (Hetzner, DigitalOcean, Lightsail, Oracle Free)** — `docker run` as above, or use systemd. Mount a host directory at `/data` for state.
- **Avoid** scale-to-zero serverless (Lambda, Cloud Run with `min=0`, Cloudflare Workers, Vercel) and platforms with ephemeral filesystems (Heroku) — both break this app.
