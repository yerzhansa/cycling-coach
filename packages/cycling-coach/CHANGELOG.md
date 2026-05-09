# cycling-coach

## 2026.5.9

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

## 2026.5.6-1

### Patch Changes

- 6ca4d4b: Fix markdown tables sent by the bot rendering as literal pipe-separated text in Telegram. Telegram has no table primitive in any parse mode, so the fix has three layers:

  - **Steer the source.** `sport-cycling/SOUL.md` now tells the LLM to format workout prescriptions as a structured interval list (one step per line: warmup → main → cooldown) and training plans as a phased list. Workouts are inherently sequential and read better on mobile as `3× 10min Z4 (240–260W) / 5min Z2 between` than as a 4-column grid.
  - **Defense in depth.** `markdownToTelegramHtml` now extracts any markdown tables that slip through and renders them as `<pre>` (monospace) blocks with columns padded and cell content HTML-escaped. Wide tables still wrap on phones, but the columns line up.
  - **Chunker safety.** Long messages that exceed the 4096-char Telegram limit are now split with `<pre>` blocks treated as indivisible units. If a `<pre>` block alone exceeds the limit, its rows are split across multiple wrapped `<pre>...</pre>` chunks so Telegram never receives an unclosed tag. Also fixes a pre-existing ordering bug where the inline-code regex ate fence backticks and broke fenced code blocks.

- ff63d54: User-facing: Added /review — get a coaching review of your last training session, with depth that auto-scales by activity type.
  User-facing: Use /review deep for race-style analysis or /review brief for a quick check; you can also pass natural language like /review my saturday ride.

  Adds two Pure-Core intervals.icu tools (`intervals_fetch_activity` and `intervals_fetch_streams`) so the agent can pull per-rep splits and raw streams when it needs them, plus a `WORKOUT_REVIEW_RULES` system-prompt block that drives the 3-questions framework, depth tiers (Tier A ~50 words / Tier B ~200 / Tier C ~500–600), the `Reply 'show numbers'` + `/review deep` footer, and the trademark cleanup (no NP/CTL/ATL/IF/TSS/TSB or "true FTP" in athlete-facing review output — uses Load / Intensity / Fitness / Fatigue / Form / weighted avg power instead). Cycling-specific guidance lives in `sport-cycling/SOUL.md` (30-min activity-clustering rule, jargon list, substitution table) and `sport-cycling/skills/review.md` (decoupling thresholds, best-efforts duration ladder, fade-pattern catalog, indoor-vs-outdoor signals).

- e0ec72d: User-facing: The bot no longer greets you with the "Welcome to Cycling Coach!" message after a redeploy or `/update`. Existing chats with an on-disk session are recognized as returning.

  The previous "have I greeted this chat yet?" tracking was an in-memory `Set` (`packages/core/src/channels/telegram.ts`), wiped on every process restart — so every existing user was treated as a newcomer on their first message after a Railway deploy or self-update. The fix consults the persisted session file in `~/.cycling-coach/sessions/telegram:<chatId>.jsonl` as a durable signal for "returning user" before showing the welcome.

- e99d184: User-facing: Added /whatsnew — see what changed in the latest version without leaving Telegram.
  User-facing: Update notifications now point to /whatsnew so you can decide whether to /update.

  Adds a new `/whatsnew` command that fetches the latest GitHub Release body for the running binary and renders only the lines tagged `User-facing:` in the underlying changesets. Engineering details, hashes, and infra-only changesets stay in `CHANGELOG.md` for git history but never reach athletes.

  Convention is documented in `.changeset/README.md`. The bot makes one anonymous GitHub API call per `/whatsnew` invocation (no caching); GitHub Releases are auto-created by `release.yml` so no extra release-process work is needed.

## 2026.5.6

### Patch Changes

- 18e7284: Add a package-level README so npmjs.com renders install/usage docs instead of the "This package does not have a README" placeholder. The README has been missing from npm since the monorepo split moved publishing to `packages/cycling-coach/`.
- 3f7285d: Clarify three setup-wizard and runtime messages that were easy to misread.

  - **`op` errors are no longer truncated mid-word.** When `op` failed (typically because the 1Password desktop app needs a restart), the wizard previously printed `1Password CLI unavailable (other: this, update the 1Password app...)` — the `slice(-200)` chopped the leading word off. The wizard now extracts a clean single-line summary (strips `[ERROR] yyyy/mm/dd hh:mm:ss` log prefix, caps at a word boundary) and translates the most common failure mode to an actionable hint: `1Password backend not offered — 1Password desktop app integration unavailable; quit and reopen the 1Password app, then re-run setup.`
  - **Keychain and 1Password writes now confirm where the secret landed.** Previously the wizard wrote the secret to the chosen backend silently and the only visible result was a `SecretRef` object in `config.yaml` — easy to misread as "the secret is stored in YAML". Each successful write now prints e.g. `Stored telegram.bot_token in macOS Keychain (service: cycling-coach, account: telegram_bot_token). config.yaml stores a /usr/bin/security reference, not the secret.`
  - **Telegram-mode banner is explicit.** `Cycling Coach is running. Waiting for messages...` looked identical to an idle CLI prompt; now reads `Cycling Coach (Telegram mode) is running. Open Telegram and message your bot — Ctrl+C to stop.`

## 2026.5.4

### Patch Changes

- 8ce9e94: Fix `/update` and the npm-update notification suggesting a downgrade when the running bot is ahead of npm.

  The version comparison was a string `!==`, so any difference between the running bot's `package.json` version and `registry.npmjs.org/<name>/latest` triggered "Update available" — including cases where the running version was newer (e.g. a Railway deploy from `main` whose CalVer is bumped before the corresponding npm publish has succeeded). On every restart the hosted bot would broadcast `Update available: <new> → <old>` to every chat, and `/update` would `npm install -g …@latest` the older version.

  Replaced with a CalVer-aware comparison (`YYYY.M.D[-N]` parsed into a 4-tuple). Returns true only when latest is strictly newer. Same-day re-release suffix `-N` is treated as newer than the unsuffixed release per the project's CalVer convention (inverts standard semver, which is why we don't use the `semver` package here).

## 2026.5.3

### Patch Changes

- 814dbfb: Fix dates near local midnight in any non-UTC timezone (closes #50).

  The system prompt now carries the IANA timezone name (cache-stable) and a fresh `Current time:` line is appended to each user message. Five "today" call-sites — system prompt, daily-notes filename, intervals_delete_workout past-workout guard, race countdown, daily session-reset hour — now share one resolved athlete TZ instead of computing UTC independently. Resolution chain: `COACH_TZ` env > `session.timezone` (config.yaml) > host TZ (warning) > `"UTC"` (loud warning).

## 2026.5.1

### Minor Changes

- 25fb017: First release after the Core/Sport seam refactor (issue #47). cycling-coach is now bundled via tsup — `@enduragent/core` and `@enduragent/sport-cycling` are inlined into the binary's `dist/index.js` rather than being declared as runtime dependencies. End users continue to install a single npm package; the workspace split is invisible to them. Stub binaries (`running-coach`, `duathlon-coach`) and library packages (`@enduragent/*`) are private and not published — they will be published when the first external consumer needs them. See ADR-0010.
