# cycling-coach

## 2026.6.25

### Patch Changes

- 1e40e7d: User-facing: Added six new LLM providers to setup — DeepSeek, Qwen, MiniMax, Kimi, Z.AI (GLM), and OpenRouter — each selectable in `setup` with its own model list and an optional base-URL override.

  Wires DeepSeek (`@ai-sdk/deepseek`), Qwen (`@ai-sdk/alibaba`), and OpenRouter (`@openrouter/ai-sdk-provider`) through dedicated AI SDK factories, and MiniMax/Kimi/Z.AI through `@ai-sdk/openai-compatible` with provider-default base URLs. Adds an `LLM_BASE_URL` override and `llm.base_url` config field, plus a pi-ai KnownProvider typing guard so the widened provider union compiles (providers absent from the priced catalog report `cost: undefined` on the usage ledger).

## 2026.6.18

### Patch Changes

- 40072ae: Derive per-call cost for the AI-SDK providers (anthropic/openai/google) in the LLM dispatch chokepoint, so the local usage ledger's cost column is populated for them — previously only the codex path carried a cost. Cost is computed from the maintained model-pricing catalog (`pi-ai`'s `calculateCost`), the same catalog the codex path already prices against. The codex path keeps its own provider-reported cost and is never re-priced, and an uncatalogued model leaves cost undefined rather than fabricating a figure.
- 62a39cf: User-facing: Lower per-message API cost on the default Anthropic model by caching the stable system prompt and tool definitions across a turn.

  Sets an ephemeral cache breakpoint on the last stable system block in the LLM dispatch chokepoint, so multi-step tool turns and the memory-flush prompt re-read the system + tool prefix at cache-read rates instead of full price. The system prompt is reordered so all static rule blocks form one frozen prefix ahead of a cache-boundary marker, with the volatile Athlete Context and time-zone blocks last, so a memory write no longer invalidates the cached prefix. Corrects two comments that wrongly claimed caching was already active.

- 00495bf: User-facing: On the ChatGPT/Codex subscription, your conversation's static context is now served from the model's prompt cache, easing usage-limit pressure during long chats.

  Threads a stable per-chat cache-routing key (sha256 prefix of the chat id, never the raw id) from the chat entry point through the codex bridge into the Responses prompt cache key. The non-codex provider path ignores the field by construction.

- 5e302b6: User-facing: The coach now carries its current training recommendation (and any pushback you've raised) across long conversations instead of sometimes losing it when older messages are condensed.

  User-facing: Session resets no longer get stuck when saving memory fails — the coach archives the conversation and starts fresh anyway.

  Compaction summaries gain a required Coach Stance section (enforced by the
  headings audit) and the MUST-PRESERVE block gains stance, dispute, illness,
  and agreed-action bullets, so the summarizer can no longer file the coach's
  own recommendation under omittable generic advice. Both reset-path memory
  flushes are now wrapped in warn-and-proceed guards so a flush failure cannot
  block the session archive.

- 9c650bb: User-facing: Long conversations are now condensed safely — the coach saves durable facts to memory and keeps a local archive of the full transcript before condensing older messages, leaves your history untouched if anything fails along the way, and completeness-checks every condensed summary.

  The trim-path compaction now flushes memory before rewriting the session
  file and skips the rewrite when the flush fails; every successful trim
  archives the pre-rewrite transcript to a .precompact sidecar governed by
  the existing opt-in retention knob. Summarization of dropped messages
  returns failed chunks to the caller instead of discarding them and throws
  on total failure so history is never replaced by an empty summary. The
  summary-quality audit is extracted into a shared post-step applied by
  both compaction pipelines, with output bounded at generation time and the
  audit running after any final truncation.

- be7db0d: User-facing: Added an optional cheaper model for memory tidy-up (config `llm.flush_model` / env `LLM_FLUSH_MODEL`); unset keeps using your chat model.
  User-facing: The first reply of the day and recovery from long conversations are faster — the bot no longer re-runs the memory tidy-up multiple times in one turn.

  The memory tidy-up can now run on a configurable cheaper model via a second, lazily-built LLM while the chat reply keeps the default model; when unset it reuses the chat model (no change). A per-turn latch deduplicates the tidy-up to at most once per chat turn — the daily-reset tidy-up counts as the one, and the trim, over-budget, and overflow-recovery paths no longer re-run it. The tidy-up and compaction calls are now tagged in the local-only usage ledger so their cost is visible.

- 4defe74: User-facing: If the coach can't fully reset your previous session, it now says so ("some earlier context may still apply") instead of failing silently.

  Memory flushes now return a structured outcome ({writes, ledgerAppends,
  finishReason, usage, shrunkSections}) instead of discarding the model
  result. A flush that writes nothing on a non-trivial conversation, or
  that shrinks a memory section by more than 30%, emits a structured warn
  event (char counts only — never section content). The flush trigger
  paths gain bounded retry and a degradation policy that defers the
  session archive when extraction visibly failed.

- 4e76fe9: User-facing: Fixed the default Google model: setups that never chose a model now use gemini-2.5-flash, replacing the retired gemini-2.0-flash that made the coach fail to respond.

  The google provider's hardcoded default pointed at gemini-2.0-flash, retired
  by Google on 2026-06-01, so env-only deployments hard-errored on every call.
  CONTEXT_WINDOWS gains a gemini-2.5-flash entry (1,000,000) so the model
  resolves its real window instead of the 200,000-token fallback.

- 8b04894: Gate the Anthropic ephemeral cache-control directive behind the anthropic provider in the LLM dispatch chokepoint, so openai/google requests carry the plain system string instead of an Anthropic-only `providerOptions` block. Document `GenerateOpts.cacheKey` as codex-only (the AI-SDK arm never reads it; it is forwarded to the codex bridge as its session id). Adds a guardrail test pinning that non-Anthropic AI-SDK providers carry no `cacheControl`/`providerOptions`.
- be42450: User-facing: The coach no longer claims it lacks your latest numbers when it has just fetched them — a premature data-grounding rule is held back until the underlying snapshot read is wired in.

  The Layer-3 data-grounding rule was pushed into every prompt before any tool surfaced the snapshot it names, so it is now gated behind a default-off module constant that the cutover flips on once the read tool lands; the ported prose is byte-unchanged and a test pins both flag states. Each assistant session line now also carries a template hash over the static prompt ingredients, an assembled hash over the full built prompt that turn, and the resolved provider and model, so a past reply maps back to its prompt revision; older sessions without the fields still load and everything stays local with zero telemetry.

- c397a32: Adds an append-only event ledger (memory/events.jsonl) recording dated
  athlete events — decisions, overrides, illness, experiments, outcomes —
  with a closed kind enum and host-stamped timestamps. The memory flush
  gains a ledger_append tool and an event-extraction prompt clause so these
  events are captured durably instead of being lost at extraction time.
- b95107a: User-facing: The coach now records when each remembered fact was last confirmed and flags facts older than six months for re-confirmation.

  Every memory section write stamps an "\_updated: YYYY-MM-DD" first body line
  (athlete-timezone date, idempotent restamp), and the memory-extraction prompt
  now requires a source and as-of date on durable facts, keeps existing dates
  on unchanged facts, and appends "(re-confirm)" to facts older than six months.

- 66fd011: User-facing: The coach can now look back through past daily notes and logged events by date — ask "what did we note in March?" and it retrieves the actual record instead of forgetting everything older than today.

  Adds a memory_query tool ({from, to, query?}) doing an index-free, case-insensitive
  substring scan over dated daily-note files plus the append-only event ledger, and a
  static recall-before-answering system-prompt rule. Tool definition and prompt rule
  are cache-stable (no per-turn variance).

- e4b1b7e: User-facing: cycling-coach now requires Node.js 22 or newer.

  The advertised runtime floor was raised from Node 20 (end-of-life
  2026-04-30) to Node 22 across the workspace package manifests and the
  install docs, matching the only Node versions any first-party runtime
  (CI, the published Docker image, the release pipeline) actually uses.

- 5c44291: User-facing: When the model provider asks the coach to back off, waits are now capped at 2 minutes — a huge provider-requested delay can no longer freeze the chat for hours.

  Clamps the header-derived retry wait in the chat retry loop to a named 120 s ceiling at the existing backoff site (the 30 s cap previously bound only the locally computed fallback). The existing rate-limit warn line now reports the provider-requested value when clamping occurs.

- 496b068: User-facing: Archived chat sessions are now kept indefinitely by default — previously only the 20 most recent were kept; a new retention setting lets you opt into age-based cleanup.

  Session reset archives were pruned to the newest 20 per chat, silently
  deleting the only copy of older conversations before any extraction
  substrate exists. The count-based prune is removed; a new
  session.resetArchiveRetentionDays config knob (env:
  SESSION_RESET_ARCHIVE_RETENTION_DAYS, default 0 = keep forever) provides
  opt-in age-based pruning instead. Archive file permissions are unchanged.

- ad3b710: User-facing: Operator pairing now requires sending a one-time code shown in your terminal, so a stranger racing you to the bot during setup can no longer claim ownership.
  User-facing: /update now installs the exact version it verified against the registry, with dependency install scripts disabled.
  User-facing: Health data, session transcripts, and memory files are now written owner-only (0600 files in 0700 directories) on every deployment path, and old session archives are pruned automatically.
  User-facing: The automatic startup update check can be disabled with CYCLING_COACH_NO_UPDATE_CHECK=1; it is now disclosed in the README's privacy section.
  User-facing: Running with CYCLING_COACH_DM_POLICY=open now prints a loud startup warning and logs each non-allowlisted sender it serves.

  Security-hardening pass across the bot's trust boundaries:

  - File permissions: all JSON/JSONL/markdown writers create files 0600 and data
    directories 0700; the data-dir tightening that previously ran only on
    allowlist writes is now an unconditional startup invariant; pre-existing
    world-readable files are tightened on rewrite. Session reset archives are
    capped at the newest 20 per chat.
  - Telegram output: raw reply text is HTML-escaped before markdown conversion
    (only converter-emitted tags survive), and a reply that Telegram rejects for
    entity-parse errors is retried as plain text instead of being dropped.
  - Prompt-injection containment: athlete memory is fenced in the system prompt
    as data-not-instructions, an untrusted-data handling rule covers tool
    results, and the codex-bridge tool loop now validates tool arguments against
    their schema before execution (parity with the AI SDK providers).
  - OAuth: refresh failures retry once before being classified as token reuse,
    refreshes are serialized per profile, profile writes are atomic, and the
    pinned pi-ai dependency is patched to stop logging token-endpoint response
    bodies on malformed responses.
  - Operator capture: pairing-code gated, queued pre-start updates dropped,
    capture confirmations default to decline on bare Enter.
  - Setup wizard: secret storage defaults to a detected keychain/1Password
    backend instead of plaintext; config dir/file permissions tightened on
    re-run.
  - Supply chain: GitHub Actions pinned to commit SHAs with Dependabot coverage,
    Docker base images pinned by digest, the container runs as the non-root
    node user, corepack's pnpm download is integrity-pinned, and the privacy
    lint now scans .changeset and root markdown surfaces.

- 63a1184: User-facing: A damaged conversation file no longer blocks the chat — unreadable lines are set aside and the rest of your conversation loads normally.

  User-facing: /start now tells you when a session reset fails instead of replying with the usual welcome as if it had succeeded.

  The session JSONL loader tolerates torn or malformed lines: invalid lines
  are quarantined verbatim to a timestamped .corrupt sidecar next to the
  session file, the session file is rewritten with only the valid lines, and
  loading never throws on corruption. The pre-reset session read is now
  best-effort (warn and archive anyway), so the reset path can no longer be
  gated behind a successful read of the state it exists to discard.

- d829e74: User-facing: The coach now saves important details to long-term memory proactively as a long conversation approaches its condensing point, instead of waiting until older messages are about to be dropped.

  When the loaded history exceeds 80% of its token budget and at least five
  messages have arrived since the last proactive save, the agent runs a
  memory flush before building the turn, so facts reach durable memory while
  the full raw history still exists. A per-chat in-memory cooldown prevents
  repeated flushes; trim-time flushes count toward it and session resets
  clear it. A flush failure warns and never blocks the turn.

- 315639a: User-facing: Condensing a long conversation can no longer hang or fail your message — summarization now times out after two minutes and the coach continues with the best summary it has.

  Every staged-summarization LLM call now runs under a 120 s race-only
  deadline (classified as a timeout by the existing error classifier).
  summarizeInStages degrades instead of throwing: a failed chunk falls back
  to the carried summary, and with no summary at all it head-drops the
  oldest messages so the turn can proceed. The overflow/timeout rescue
  paths rethrow the ORIGINAL turn error with any rescue failure attached
  as its cause, so summarization failures can no longer mask the error
  that actually ended the turn.

- d1889d1: Record per-turn token usage and cost on the local usage-ledger turn line. The chat turn line previously carried only timing (`durationMs`); it now also folds in the winning generation's input/output/total tokens, cache read/write tokens, and cost, mirroring the per-generation line. v1 records the final successful generation's figures — not a sum across retry/compaction attempts — and a true turn-wide accumulator is deferred.
- 7ddfde3: Internal refactor: route the per-generation and per-turn usage-ledger lines through one shared `usageFieldsFromResult` mapper, and assert the AI-SDK `inputTokenDetails` cache-token shape in a single `cacheTokenDetails` helper, instead of copying the field-by-field block and cast across `llm.ts` and `coach-agent.ts`. Behavior-neutral.

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
