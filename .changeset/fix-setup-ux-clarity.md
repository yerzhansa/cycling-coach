---
"cycling-coach": patch
---

Clarify three setup-wizard and runtime messages that were easy to misread.

- **`op` errors are no longer truncated mid-word.** When `op` failed (typically because the 1Password desktop app needs a restart), the wizard previously printed `1Password CLI unavailable (other: this, update the 1Password app...)` — the `slice(-200)` chopped the leading word off. The wizard now extracts a clean single-line summary (strips `[ERROR] yyyy/mm/dd hh:mm:ss` log prefix, caps at a word boundary) and translates the most common failure mode to an actionable hint: `1Password backend not offered — 1Password desktop app integration unavailable; quit and reopen the 1Password app, then re-run setup.`
- **Keychain and 1Password writes now confirm where the secret landed.** Previously the wizard wrote the secret to the chosen backend silently and the only visible result was a `SecretRef` object in `config.yaml` — easy to misread as "the secret is stored in YAML". Each successful write now prints e.g. `Stored telegram.bot_token in macOS Keychain (service: cycling-coach, account: telegram_bot_token). config.yaml stores a /usr/bin/security reference, not the secret.`
- **Telegram-mode banner is explicit.** `Cycling Coach is running. Waiting for messages...` looked identical to an idle CLI prompt; now reads `Cycling Coach (Telegram mode) is running. Open Telegram and message your bot — Ctrl+C to stop.`
