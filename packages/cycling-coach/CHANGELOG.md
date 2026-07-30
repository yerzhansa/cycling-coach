# cycling-coach

## 2026.7.28

### Minor Changes

- 2a762ce: User-facing: Default and recommended LLM models upgraded to the newest generation — GPT-5.6 Sol (OpenAI and ChatGPT sign-in), Claude Sonnet 5, Gemini 3.6 Flash, Kimi K3, MiniMax M3, and Qwen3.7 Plus.

  Refreshes the per-provider default model map, the setup wizard menus, and the context-window table for the July 2026 lineups (GPT-5.6 Sol/Terra/Luna, Claude Sonnet 5 / Opus 5 / Fable 5, Gemini 3.6 Flash + 3.5 Flash Lite, Kimi K3, MiniMax M3, Qwen3.7 Plus/Max). Extends the usage price table with the new models (including OpenRouter slugs), fills in the previously zero-priced GLM-5.x rows, and bumps the unknown-codex-model price fallback from gpt-5.4 to gpt-5.6-sol rates. Existing explicit model configs are unaffected — all previously catalogued IDs remain priced and resolvable.

### Patch Changes

- ea19abc: User-facing: Zone-based warmup ramps now render on the calendar power chart, and planned duration and Load for pushed workouts are derived by intervals.icu from the steps themselves.
- 371402c: User-facing: Workouts the coach adds to your intervals.icu calendar are now marked as coach-created, and the coach will only delete its own scheduled workouts — races, notes, and workouts you added yourself are always refused.

  Calendar create tools in both sport packages stamp an `external_id` and `tags` provenance marker on every event they push. The list projection surfaces `category`, `externalId`, `tags`, and a derived `coachCreated` flag, plus an opt-in `coachCreatedOnly` filter. The delete tool now refuses non-WORKOUT events (`not_a_workout`) and marker-less events (`not_coach_created`) before the destructive delete call, ahead of the existing past-date guard.

- f512ba3: Ship package license, notice, and graph-derived third-party legal artifacts.
- 8fe4c26: User-facing: Conversation summaries created during long sessions are now saved into the coach's dated memory notes, so they survive session resets and stay searchable later.
- 6340b6a: User-facing: Coaching replies and raw training snapshots now include Garmin attribution only when their data has a confirmed Garmin source.
- 55ac928: User-facing: Calendar changes and plan saves now ask for your confirmation first — the coach proposes, and you tap Confirm or Cancel (or answer y/N in the terminal) before anything is written.
- 4ccdf20: User-facing: Chat requests to intervals.icu now time out after 30 seconds instead of hanging a coach turn indefinitely.

  Route every intervals.icu client built by the factory (sync and chat) through one process-wide request bucket (10 requests/second, burst 30) so multiple clients can no longer burst past the intended combined pacing. Chat clients now get the same abortable per-request timeout wrapper as sync clients; the timeout covers queue wait plus the HTTP call, queued waits abort promptly, and lib-level retries stay disabled (`maxAttempts: 1`) on both paths.

- 1e40c2e: User-facing: Saved memory no longer gets corrupted when a note contains markdown section headings.

  Demote line-start `## ` headings to `### ` inside the single section-write
  choke point so heading-bearing content can no longer fragment the section map,
  shadow a real section, or leave orphan fragments across reads and replaces.
  Export a 4000-char per-section soft cap that emits one structured warn (never
  truncates) when a stamped body exceeds it.

- bc1cd7c: User-facing: Long-term memory no longer crowds out conversation history — only your core profile is pinned into every reply, and the coach fetches the rest on demand.

  Tier memory injection so only always-inject sections (person, goals, preferences, medical history, schedule, and the sport profile) render into the system prompt's athlete context; notes, equipment, and history stay on disk and remain reachable through the memory read tool. Add a prompt-layer section budget that nudges the flush pass to move dated detail into daily notes instead of growing a section, and hard-cap the rendered athlete context with a disclosed, warned truncation. Harden the athlete-data fence: a new reusable prompt-fence module neutralizes fence tokens and strips control/format characters, and every tool result is marked as untrusted data at a single choke point so stored or external text can never escape its fenced block.

- ff98c56: User-facing: A corrupted or hand-edited plan file no longer breaks the chat — the coach simply continues without the plan summary.

  [Engineering: loadPlan now goes through safeReadJson with a loose passthrough schema; plan summary omits missing fields instead of rendering "undefined"; orphan MEMORY.md sections emit a names-only structured warn at startup + post-flush; deprecated Memory.appendMemory deleted (zero callers, never on the interface); appendDailyNote skips exact-duplicate notes.]

- ebfe55d: User-facing: Long chats that hit the model's context limit now compact and retry to produce a complete answer instead of returning a cut-off reply.

  Harden context-overflow classification, token estimation, and effective-window caps. Context-overflow classification now recognizes structured provider signals (Codex-normalized `ContextOverflowError`, and 400 responses whose body carries a known overflow code or message) on top of the existing message fallbacks, without treating every 400 as overflow. A successful `length` finish whose prompt already filled the real provider window is routed through the existing compaction rescue rather than persisting the truncated text; plain output-length truncation keeps the earlier empty-reply recovery. Token estimation counts part-array/structured message content instead of dropping it to zero and can anchor budget math to the provider's reported token usage. History budget, preemptive compaction, and compaction chunk sizing use a 200,000-token effective estimator window (`min(providerWindow, 200k)`) so a million-token provider window no longer expands the planning target.

- 13af149: User-facing: Coach can now schedule strength sessions on your intervals.icu calendar — free-text exercises, sets, reps, and RPE.
- 4da026b: User-facing: Rapid messages sent within about 1.5 seconds of each other are now combined into a single reply, so a thought split across several messages gets one coherent answer instead of several partial ones.

  Buffers free-form Telegram text per chat behind a 1.5s debounce window (each fragment resets the window) and joins fragments with newlines into one turn. A slash command flushes the chat's pending text first, then runs immediately, so commands are never coalesced into free-form text. Turn dependencies are resolved at flush time, the flushed turn threads to the last fragment's message id, each fragment fires one best-effort typing action during the window, and shutdown/update drains flush pending buffers synchronously without waiting on the debounce timer. Debounce timers are unref'd so a pending buffer never holds the process open.

- 54f6f54: User-facing: Messages you send while the bot is offline are no longer dropped when it restarts, and when a new daily session starts the bot now tells you your earlier conversation is archived and your key details are still remembered.

  Normal startup no longer drops pending updates; a durable, owner-only offset store (keyed by a short token fingerprint, never the raw token) dedupes anything a previous run already handled and stops `/update` from re-triggering itself after a self-update restart. Operator-capture startup still intentionally drops prior updates. A daily session reset is deferred for one turn when the last exchange is still recent (within 30 minutes), so a conversation that crosses the daily boundary isn't archived mid-thread; malformed timestamps and idle resets are never deferred. On an automatic reset the first reply is prefixed once with a plain-language notice and the model sees a one-turn archive marker so it discloses the fresh session. The athlete's message is now made durable before generation and a failed turn is recorded with a terminal marker, so a mid-turn crash no longer silently erases the message. Compaction now preserves surviving messages' original timestamps.

- e5d8e32: User-facing: Sketching a training plan no longer silently saves it — the coach saves a plan only after you approve it.
  User-facing: The coach now refuses to schedule a workout on a past date instead of creating an event it can't remove.

  Tighten tool inputs for dates, activity IDs, streams, memory sections, and saved plans.

- 403fb5e: Trim serialized tool descriptions and add per-sport payload size regression ceilings.
- 03964f0: User-facing: Fixed a rare bug where an emoji sitting exactly at a length limit could be sliced in half, producing garbled text in long Telegram code blocks, compaction summaries, and memory query results.

  All fixed-length string cuts now route through a shared `truncateUtf16Safe` helper that backs the cut off by one UTF-16 unit when it would bisect a surrogate pair. Fixed sites: `splitPreBlock`'s oversized-row fallback and `hardSplit`'s pathological fallback in the Telegram chunker, `capSummary` in compaction, and the `memory_query` result cap. (docs/issues #171)

## 2026.7.2

### Patch Changes

- d52e710: User-facing: Fixed a startup crash that stopped the bot from launching on the latest release.

  The published binary bundles workspace packages inline, which pulls in transitive CommonJS dependencies whose `require()` of Node builtins hit esbuild's ESM dynamic-require shim and threw at startup. A `createRequire` banner in the bundle gives that shim a real `require` to delegate to, so the builtins resolve normally.

## 2026.7.2

### Patch Changes

- af3186e: User-facing: Coach replies now get a bounded model-call deadline and one safe retry for plain timeouts instead of hanging indefinitely.
  User-facing: Training plans are no longer at risk of being duplicated when a request times out or context overflows.
  User-facing: Long chat turns are now bounded so they can't run roughly twice the intended time.

  Bound owned LLM calls with an abort deadline and guard timeout retries from replaying committed tool writes.

  When a turn has already committed a memory or plan write and then fails (overflow/timeout), it now returns the canned "couldn't finish" message instead of self-healing via replay — deliberately preventing a re-run of the non-idempotent write. The committed write is preserved; only the in-turn answer is sacrificed.

- 33aa8bc: User-facing: Telegram now retries failed message delivery, threads replies to your message, and shows clearer error messages; the CLI no longer prints raw error objects.

  Splits generation from delivery in the Telegram turn so a post-generation delivery failure is no longer shown generation copy, installs a bounded API-level retry transformer, adds a process-local resend cache (send "resend" to re-emit the last answer), threads final replies to the inbound message, moves the auth `next()` outside its guarded block so downstream handler errors are no longer mislabeled as security errors, registers a last-resort `bot.catch`, and routes both the Telegram channel and the CLI through one shared error classifier.

- 2dfb2e3: User-facing: Coach replies now get more time to finish on complex requests before timing out.

  Raise the owned model-call deadlines and the per-turn wall-clock so a legitimately-slow reasoning turn is not cut off prematurely: flush/compact 3->5 min, chat 5->10 min, per-turn wall-clock 5->10 min. The chat per-call deadline is clipped by the turn's remaining wall-clock budget, so raising the chat cap is only effective alongside the matching wall-clock raise.

- 1dcce7b: User-facing: The bot now shows a typing indicator while it works on your message, so a long reply no longer looks like it went silent.

  Starts a best-effort heartbeat that re-emits Telegram's native "typing" chat action every 4s for the duration of the generation phase in the shared turn skeleton, then stops it in a `finally` around generation (never around delivery). Each pulse is isolated: a rejected or throwing pulse is logged at debug and can never affect the turn or its reply, and the interval is unref'd so a pending pulse cannot hold the process open during shutdown or an `/update` drain.

- abcbefd: User-facing: Long-running deployments now check for updates daily, not only at restart.

  Route the existing startup version check through an update endpoint that returns the latest published version and records an anonymous per-instance count. A daily re-check runs alongside the startup check so long-running deployments learn about new releases without a restart; both automatic checks respect `CYCLING_COACH_NO_UPDATE_CHECK`. Dev/test and any endpoint outage fall back to `registry.npmjs.org`, so update checks and notifications keep working.

## 2026.6.30

### Patch Changes

- 3282be9: User-facing: Update notifications now link to a short customer discovery survey so you can help prioritize mobile app, 24/7 bot, Railway template, and setup/payment work.

  Replace the X.com feedback prompt in the Telegram update-available broadcast with the Tally survey call-to-action.

## 2026.6.29

### Patch Changes

- 4ff5428: User-facing: Managed container deploys now explain that updates happen by redeploying the image instead of trying to run npm self-update inside the bot.

  Publish and document the official GHCR image path for Railway image-backed templates.

- 34c4bd4: User-facing: Container and Railway deploys can now set `LLM_PROVIDER` plus a generic `LLM_API_KEY` for any API-key LLM provider. Provider-specific env vars such as `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, or `OPENROUTER_API_KEY` still work and take precedence.
- bdbb513: User-facing: Want the bot running 24/7 without keeping your computer on? Deploy the Railway template: https://railway.com/deploy/cycling-coach

## 2026.6.25-1

### Patch Changes

- 6af0cc6: User-facing: Refreshed the model picker to the current generation — added Claude Opus 4.8, GPT-5.5, Gemini 3.5/3.1, GLM-5.2, MiniMax M3/M2.7, Kimi K2.6 and Qwen 3.5, and retired stale options.
  User-facing: A single server hiccup or network blip from the AI provider no longer ends your turn — the coach now retries briefly and keeps going.
  User-facing: A backward or frozen system clock no longer makes stale training data appear fresh.
  User-facing: The coach now declines to quote numbers from stale data and tells you so, instead of fabricating from a stale cache.
  User-facing: A sync hiccup no longer silently blanks your data behind a "fresh" stamp — if a data source errors, the coach keeps the last good snapshot and records the failure instead of overwriting it with empties.
  User-facing: /sync now replies instantly when a sync is already running, instead of appearing to hang.
  User-facing: Fixed a bug where a full disk could discard a reply you'd already received — the coach now always shows the reply and tells you once if it couldn't save it to your history.
  User-facing: Added a per-turn safety cap so a flaky provider connection can never run up a large surprise bill on your API key in a single message.
  User-facing: Fixed a bug where retrying after a hiccup could create a duplicate workout on your calendar; the coach now tells you honestly if a change was saved but the reply didn't finish.
  User-facing: The coach no longer silently half-schedules a multi-workout week — it confirms the plan and writes workouts across follow-up turns instead of running out of room mid-write.
  User-facing: Repeated identical data lookups within a single message are reused instead of re-fetched, so the coach answers faster and uses less of your API budget.
  User-facing: A coaching turn that runs out of steps now tells you what it gathered and to ask it to continue, instead of failing with a generic apology.
  User-facing: Deep race-review turns with very large data fetches now degrade gracefully instead of failing.
  User-facing: /quit, /exit, and Ctrl-D now exit cleanly, and startup shows a "syncing training data" line (with an explanation if the first sync fails).
  User-facing: The bot now answers quick commands like /version while a long /plan is still being generated, and Telegram's "/" menu lists every command.
  User-facing: Workout prescriptions and code blocks now render exactly as written, links are clickable, and formatting errors fall back to clean readable text.
  User-facing: The coach now mirrors your wording — it explains efforts in plain feel-language unless you used the technical term first, names the signal behind every recommendation, and the cycling zone numbers it prescribes now match the mainstream 7-zone scheme your head unit uses.
  User-facing: The "update available" notification now invites you to tag or DM @yerzhansa on X.com with feedback, feature requests, or bugs.

  These athlete-facing improvements all shipped in the 2026.6.25 binary, but their release notes were filed against the private `@enduragent/core` package, so the published `cycling-coach` release (the source `/whatsnew` reads) never carried them. This notes-only changeset re-files them under `cycling-coach` so the next release surfaces them. The CI guard added alongside this change prevents the misfiling from recurring.

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
