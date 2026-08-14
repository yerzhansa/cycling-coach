# Model providers

Enduragent does not resell tokens. You point it at an account you already have, and your provider
bills you. This page lists every lane in detail; the setup wizard (`cycling-coach setup`) covers
the common ones interactively.

## Choosing a provider

**LLM provider options:**
- **Anthropic (Claude)** — console API key from [Anthropic Console](https://console.anthropic.com/). Recommended default.
- **OpenAI (GPT)** — console API key from [OpenAI Platform](https://platform.openai.com/).
- **Google (Gemini)** — console API key from [Google AI Studio](https://aistudio.google.com/).
- **DeepSeek** — API key from [DeepSeek Platform](https://platform.deepseek.com/).
- **Qwen** — API key from Alibaba Cloud DashScope.
- **MiniMax** — API key from [MiniMax Platform](https://platform.minimaxi.com/).
- **Kimi** — API key from [Moonshot AI](https://platform.moonshot.ai/).
- **Z.AI (GLM)** — API key from [Z.AI](https://z.ai/).
- **OpenRouter** — API key from [OpenRouter](https://openrouter.ai/).
- **OpenAI Codex (ChatGPT subscription) — experimental** — browser OAuth sign-in with your ChatGPT Plus / Pro / Business / Edu / Enterprise account. No API key needed; the bot uses your subscription quota. Minimum tier: ChatGPT Plus ($20/mo). Select it in `cycling-coach setup` to start the OAuth flow. Models offered in the wizard: `gpt-5.4` (balanced, recommended) and `gpt-5.4-mini` (faster, smaller context). Cost is covered by the subscription regardless of which model you pick — the choice is speed vs capability, not price. On hard rate-limit failures the bot retries up to 4× with backoff (~35s total) before reporting the error to the chat.
- **Claude subscription (Claude Code CLI) — experimental** — drives the [Claude Code CLI](https://claude.com/claude-code) installed on your own machine, so your Claude subscription covers the usage and no API key is involved. Sign in once yourself: run `claude` in your terminal and complete the sign-in there. The app never signs you in, never reads or stores your tokens. Select it in `cycling-coach setup`; the wizard checks the CLI and prints `Signed in as <email> - Claude <plan> subscription`. Models offered in the wizard: `sonnet` (default), `opus`, and `haiku`. **macOS and Linux only this wave — Windows is not supported for this lane.** Because it needs a locally installed, signed-in CLI, it does not work in containers or on Railway (see below).

- **Codex agent (ChatGPT subscription, config-file only) — experimental, off by default** — delegates the whole coaching turn to the [Codex CLI](https://developers.openai.com/codex/cli) installed on your own machine, so your ChatGPT subscription covers the usage. Unlike every other option this one is **not offered in the setup wizard** and cannot be selected from the desktop app; you enable it by editing `config.yaml` (see below). Install `codex` (≥ 0.46.0) and sign in once yourself with `codex login` — the app never signs you in, never reads or stores your tokens. **macOS and Linux only; Windows is refused.** Because it needs a locally installed, signed-in CLI, it does not work in containers or on Railway.

Anthropic's Claude Pro/Max subscription does **not** support OAuth for third-party tools (per Anthropic ToS), and Cycling Coach never brokers a Claude login. The two supported Anthropic paths are the console API key and the Claude Code CLI lane above, which delegates to the CLI you signed in yourself.

## Where to get other keys

**Where to get other keys:**
- **intervals.icu**: [intervals.icu/settings](https://intervals.icu/settings) > Developer Settings
- **Telegram**: Message [@BotFather](https://t.me/BotFather) > `/newbot`

## Provider configuration in YAML

For the Codex OAuth path, the config has no `api_key` — tokens live in `~/.cycling-coach/auth-profiles.json` (mode `0600`) and rotate automatically:

```yaml
llm:
  provider: openai-codex
  model: gpt-5.4
  auth_profile: openai-codex
```

The Claude Code CLI path has no `api_key` either — the CLI uses the login you created in your own terminal, and Cycling Coach never touches those credentials:

```yaml
llm:
  provider: claude-cli
  model: sonnet                             # or opus / haiku
  claude_cli:
    enabled: true
    binary_path: /opt/homebrew/bin/claude   # optional; resolved automatically when omitted
    config_dir: ~/.claude                   # optional; only set it for a non-default CLI config dir
    billing: subscription                   # or api-key — explicit opt-in, see below
```

`billing: subscription` is the default and never hands an API key to the CLI. Set `billing: api-key` only if you want the CLI to bill an Anthropic API key you have already approved inside the CLI — that opt-in is explicit, and usage is then charged to your API account instead of your subscription.

**Kill switch:** set `ENDURAGENT_CLAUDE_CLI_DISABLED=1` (or `true`, case-insensitive) to disable this provider on an instance; `llm.claude_cli.enabled: false` does the same from YAML. A running daemon does not need a restart — it re-checks the switch every turn, so a flip takes effect on the **next turn**, which is then refused with an explanation. `CLAUDE_CLI_PATH` overrides `llm.claude_cli.binary_path`.

#### Codex agent (experimental, off by default)

This lane is config-file only — the setup wizard does not offer it, and it stays disabled until you write `enabled: true` yourself:

```yaml
llm:
  provider: codex-agent
  model: gpt-5.6-sol
  codex_agent:
    enabled: true                          # required — the lane refuses without it
    binary_path: /opt/homebrew/bin/codex   # optional; resolved automatically when omitted
    reasoning_effort: medium               # optional; low / medium / high / ultra
```

There is no `api_key` and no `base_url` — both are rejected, because the CLI owns the endpoint and your subscription covers the usage. `CODEX_CLI_PATH` overrides `binary_path`.

**This lane works differently from every other provider, and the difference is worth understanding before you enable it.** The others send a prompt and get a reply back; here your turn is handed to Codex's own agent loop. Cycling Coach injects its coaching tools into that loop over a local MCP endpoint — 18 of them for cycling with intervals.icu connected, fewer without — and supplies the coach persona as *developer instructions* — steering the agent rather than replacing its system prompt. Practically: the retry loop, the tool wrapper stack, the ledger and your stored history all still work, but Cycling Coach gives up in-context prompt control and per-model-call accounting. One coaching turn is billed as one call against your subscription no matter how many model calls Codex makes internally, so ledger rows for this lane are marked notional and excluded from the spending cap. That trade is why it ships off by default.

For the duration of a coaching turn, your own `~/.codex/config.toml` is neutralized: every MCP server you have configured is disabled, along with shell execution, multi-agent, plugins, apps, hooks, browser and computer use, and web search. The model provider and endpoint are pinned, sandboxing is read-only, and no approval can be requested or interactively granted — the coach's own tools carry standing pre-approval so they can run unattended, and a turn is refused if that pre-approval has been widened to anything else. If any of that cannot be verified on the spawned process, the turn is refused rather than run in a degraded configuration.
