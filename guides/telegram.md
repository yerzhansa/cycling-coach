# Telegram

Your bot is your own, in both modes: paired to the desktop app (Settings → Telegram), or
self-hosted so it answers around the clock (see [deploy.md](./deploy.md)). The commands are the
same either way — they are listed in the [README](../README.md#telegram-commands).

## Who can talk to your bot

Cycling Coach restricts Telegram interactions to a configured allowlist of user IDs. Only senders in `~/.cycling-coach/allowed-senders.json` (or set via the `CYCLING_COACH_OPERATOR_ID` env var, single ID) can interact with the bot. Random Telegram users who discover your bot's username are dropped at the middleware layer.

### First-time setup

The setup wizard prompts you to send `/start` from your Telegram account; the wizard captures your user ID and writes the allowlist file automatically — you never type your numeric ID.

### Migration for existing installs

When you run `cycling-coach` on an upgraded install with no allowlist yet:

- **Interactive shell (TTY available):** the bot prompts you to send `/start` from your Telegram app. It captures your user ID, asks you to confirm, and writes the allowlist. Total friction: one Telegram message + one keypress. **You never type your user ID anywhere.**
- **Non-interactive (Docker, systemd, fly.io, `cycling-coach &`):** the bot starts in pairing mode. DM it once — the reply contains your Telegram user ID and the exact CLI command to run. Copy-paste from the reply: `cycling-coach add-sender <id>`. Total friction: about 30 seconds.

### Adding friends

`cycling-coach add-sender <userId>`

A friend's user ID appears in the bot's pairing-challenge reply when they first try to message it.

### Removing senders

`cycling-coach remove-sender <userId>`

If you remove the only allowed sender, the bot drops back into pairing mode automatically.

### Listing the allowlist

`cycling-coach list-senders`

Prints the current policy, allowed senders with their `addedAt` timestamps, and any session files left on disk from prior conversations (useful for identifying who's been DM-ing the bot).

### Stranger sessions left over from before the upgrade

Pre-upgrade, the bot accepted DMs from anyone who knew its username. Their session files (`~/.cycling-coach/sessions/telegram:<chat-id>.jsonl`) remain on disk after migration — they're no longer queryable through the bot, but they still exist. Manual deletion is safe (`rm` of any chat-ID that isn't yours). A `cycling-coach prune-sessions` CLI is tracked as a follow-up.
