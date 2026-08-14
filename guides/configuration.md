# Configuration

The setup wizard (`cycling-coach setup`) covers the common path. Everything below is for the cases
it does not: hand-edited config, environment variables, and keeping secrets out of the config file.

Provider-specific YAML (Codex, Claude Code CLI, the Codex agent lane) lives in
[providers.md](./providers.md).

## Alternative config: YAML

Instead of env vars, you can create `~/.cycling-coach/config.yaml`:

```yaml
llm:
  provider: anthropic
  model: claude-opus-4-6
  api_key: sk-ant-...
  flush_model: claude-haiku-4-5-20251001 # optional: cheaper model for memory tidy-up

intervals:
  api_key: your-intervals-api-key
  athlete_id: "0"

telegram:
  bot_token: "123456:ABC..."
```

Env vars take precedence over YAML.

### Cheaper model for memory tidy-up

The bot periodically summarizes a conversation into structured memory ("memory tidy-up"). This runs on your chat model by default, but it is a mechanical extract-the-facts task that a cheaper model handles just as well. Set `llm.flush_model` in `config.yaml` (or the `LLM_FLUSH_MODEL` env var) to route only the tidy-up through a cheaper model while your chat replies keep the default model. When unset, the tidy-up reuses your chat model (no change). Suggested cheap models per provider: Anthropic — a haiku-class model such as `claude-haiku-4-5-20251001`; OpenAI — a mini-class model such as `gpt-5.4-mini` or `gpt-4o-mini`; Google — a flash-class model such as `gemini-2.5-flash`.

## Storing secrets outside config.yaml

If you don't want API keys to live as plaintext in `~/.cycling-coach/config.yaml`, any secret field (`llm.api_key`, `intervals.api_key`, `telegram.bot_token`) can be replaced with a **SecretRef**. Two shapes are supported:

- **`source: exec`** — runs an external command (1Password CLI, Vault, `age`, etc.) and reads its stdout. Best for local desktop use with a password manager.
- **`source: env`** — reads a process env var directly (no spawn). Best for cloud / Docker / Railway / Kubernetes where the platform injects secrets as env vars.

```yaml
# exec — local with 1Password
llm:
  provider: anthropic
  model: claude-sonnet-4-6
  api_key:
    source: exec
    command: op
    args: [read, "op://Personal/Anthropic/credential"]

# env — cloud / Docker
llm:
  provider: anthropic
  model: claude-sonnet-4-6
  api_key:
    source: env
    var: ANTHROPIC_API_KEY
```

**Precedence**: env var (the legacy `ANTHROPIC_API_KEY` / `INTERVALS_API_KEY` / `TELEGRAM_BOT_TOKEN` keys) > SecretRef > plain YAML. Setting `ANTHROPIC_API_KEY` in your shell still wins — useful for debugging a vault issue without touching YAML.

**`exec` requirements**:
- The `command` must print **only the secret** to stdout. JSON blobs, labels, or extra output will be stored verbatim and downstream APIs will reject them.
- A single trailing `\n` or `\r\n` is trimmed; all other whitespace is preserved.
- Empty output, non-zero exit, a 30s timeout, or output over 64KB is a fatal startup error with a clear stderr message.
- `shell: false` — `command` and `args` are passed directly to the OS. `~`, `$HOME`, globs, and shell operators are **not** expanded. Use absolute paths.

**`env` requirements**:
- `var` must name an env var that is set and non-empty at startup. Unset → `ENOENT`; empty string → `EMPTY`. Both are fatal startup errors.
- The value is used verbatim — no trimming, no shell interpretation. If your platform's secret manager appends a newline, set the env var without it.

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
