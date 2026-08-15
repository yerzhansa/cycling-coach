# @enduragent/desktop-renderer

## 0.0.5

### Patch Changes

- 4555c74: User-facing: Connecting intervals.icu now repairs an outdated saved Athlete ID when the copied key verifies the current training account, instead of rejecting a valid key.
  User-facing: Setup now tells you to copy the intervals.icu API key again when the clipboard is empty, instead of saying intervals.icu rejected it.
- 4555c74: User-facing: Setup is now its own full-window screen that opens first and stays up until you answer all three required questions — what powers your coach, Intervals.icu, and your injury status. Telegram remains available there as an optional connection.

  The desktop Shell renders the setup gate instead of the sidebar and views while setup is required, so the chat surface is unmounted rather than hosting an in-thread setup card. Credential repair stays reachable inside the gate through the shared credential feedback block.

- 4555c74: User-facing: Setup no longer asks whether a clinician has cleared you — an injury answer alone completes the injury question.
- 846b0d8: User-facing: Claude Code now starts only for Claude work and uses a private Enduragent folder with none of your files.

## 0.0.4

### Patch Changes

- 3e8fbe5: User-facing: Added optional Telegram bot setup directly to the desktop Chat setup screen.
  User-facing: Moved required desktop setup into Chat and kept it available in Settings for recovery.

  Setup now stays in Chat until the coach is ready and remains available at the top of Settings for credential and training-data recovery.

  Desktop setup readiness is rechecked from durable runtime state on every launch, and chat actions fail closed until the provider, training data, and saved safety intake are ready.

  Chat setup can connect a Telegram bot from a copied BotFather token and safely delete its connection from this Mac, and always keeps pairing and access management in Settings.

- a6a2cf4: User-facing: Desktop now asks you to quit and reopen the app when an update check cannot safely continue, instead of offering a retry that cannot run.

  Invalidate timed-out updater generations, fence late completions, and keep automated and manual checks disabled until process restart after timeouts or updater startup failures because the native macOS updater does not expose a supported instance reset.

- da84213: User-facing: Desktop update actions now wait for in-progress Settings changes to finish before restarting the app.

## 0.0.3

### Patch Changes

- 0da7580: User-facing: Desktop now uses the Enduragent logo as its app icon and has a simpler sidebar with clearer training-data sync status.

  Replace the default packaged application icon with the website mark, remove sidebar surfaces that duplicate Chat navigation or expose internal process state, and label successful refreshes as "Training data synced."

## 0.0.2

### Patch Changes

- d22fb9a: User-facing: ChatGPT sign-in now finishes promptly after browser approval, shows clear progress, supports cancellation, and can retry coach activation without another login.
- e4543b7: Render Desktop coach prose in the native system font, dropping the bundled Source Serif 4 webfont and its NOTICE entry.
- 78971cb: Adds boundary-scoped archived conversation reads (list plus a cursor-namespaced page reader) through the durable transcript store, daemon RPC registry, main-process IPC, and the validated preload bridge. Current-conversation hydration is untouched; the archived surface has no composer, retry, or resume path. Protocol version moves to 11 because the wire method set grew.
- 2e61329: Add curated and custom model selection, write-only endpoint overrides, explicit provider activation, and retry-safe non-secret Setup drafts.
- 2e437f8: User-facing: Added an optional Desktop-hosted Telegram bot with private pairing, local-only availability, and separate Telegram chat history.

  Added main-only clipboard capture, a strict redacted mutation contract, a coherent encrypted bot profile, visible replacement controls, background startup, transient sleep/resume handling, and generation-drained token replacement for Desktop Telegram setup.

- 810b29e: Add bounded, cursor-stable transcript pagination for the canonical Desktop conversation across the durable store, daemon RPC, main-process IPC, and validated preload bridge.
- 9f9d8c2: User-facing: Setup now remembers the Claude subscription lane instead of showing Anthropic when you reopen it.

  `credential_configured` was derived from a non-empty `llm.api_key` for every provider except `openai-codex`, so the keyless lanes that never write a key — `claude-cli` and `codex-agent` — were structurally false forever. That nulled the onboarding wizard's active provider, and the Setup draft then fell through to the first entry in the provider catalogue. The runtime check now short-circuits on `isKeylessProvider` and only falls through to the key-length test for providers that actually hold a key. The `openai-codex` branch stays ahead of that short-circuit, so the ChatGPT lane still depends on a stored auth profile rather than reporting itself configured with nothing on disk.

  Populating the active provider exposed a latent assumption in the Settings coach panel: it treated an active provider that is absent from the public model catalogue as an unloadable configuration. `codex-agent` is deliberately absent from the catalogue, so that path became reachable for the first time and would have left those athletes on a dead error screen with no way to switch away. The panel now loads with the provider list intact and no draft selection, and the coach route row reads the active provider off the runtime snapshot instead of the draft, so it no longer reports "Not configured" for a provider that is actually serving turns. An empty catalogue is still a genuine load error.

- fa0f19d: User-facing: Telegram settings now replace expired pairing instructions with the bot's current pairing state.

  Reconcile action feedback against semantic bot, power, channel, and pairing state so successful instructions cannot outlive the state that produced them, while preserving warnings and errors across health polls.

- 24437a7: User-facing: Telegram setup now explains how to recover when secure token storage or Keychain access is unavailable without changing the current bot.

  Preserve closed secure-storage refusal reasons across the Desktop process boundary, refuse unencrypted token storage, and emit stage-and-reason-only local diagnostics without exposing credential details.

- Updated dependencies [4f99951]
- Updated dependencies [d22fb9a]
- Updated dependencies [fc9ed36]
- Updated dependencies [61a8940]
- Updated dependencies [78971cb]
- Updated dependencies [1977c1b]
- Updated dependencies [2e437f8]
- Updated dependencies [810b29e]
- Updated dependencies [e09a645]
- Updated dependencies [67174e9]
- Updated dependencies [aebc383]
  - @enduragent/coach-contract@0.1.1
  - @enduragent/coach-client@0.1.1
