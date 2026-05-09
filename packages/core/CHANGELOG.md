# @enduragent/core

## 0.0.1

### Patch Changes

- 4a4f538: User-facing: Tightened access — the bot now only responds to authorized Telegram senders. Existing operators: send `/start` once after upgrading, the bot prompts to claim ownership.

  Adds a per-user-ID allowlist to the Telegram channel. New behavior:

  - **Auth middleware** registered before any handler (factory-wrap pattern) filters every inbound message on `from.id`. Strangers in pairing mode get a one-time challenge with their own user-ID and instructions; allowlist mode silently drops.
  - **Migration:** no auto-claim. Default policy is `pairing` whenever `~/.cycling-coach/allowed-senders.json` is missing. On interactive startup (TTY), the bot prompts to claim. Headless paths fall back to pairing-mode + CLI claim.
  - **CLI:** `cycling-coach add-sender <id>`, `remove-sender <id>`, `list-senders`. PID lockfile serializes mutations.
  - **Persistence:** atomic `.tmp` + rename, mode `0o600`, dir mode tightened to `0o700`. Schema-validated on load with explicit fallback to `pairing` on malformed input. Transformer-pattern `saveAllowedSenders` ensures the read-modify-write cycle is atomic per process (closes a TOCTOU class).
  - **`notifyUpdate`** now filters its broadcast list against `allowFrom`, so pre-allowlist strangers' chat-ids stop receiving update pings.
  - **No proactive Telegram broadcast** under any branch (operator constraint). Migration diagnostics go to stderr only.

  Env vars: `CYCLING_COACH_OPERATOR_ID` (single ID, file precedence beats env), `CYCLING_COACH_DM_POLICY=open` (debug escape), `CYCLING_COACH_SETUP_CAPTURE_TIMEOUT_MS` (default 60s), `CYCLING_COACH_CAPTURE_CONFIRM_TIMEOUT_MS` (default 5min).
