# @enduragent/coach

## 0.1.0

### Minor Changes

- 10c6d16: Add read-only local bundle projection for the Reference layer.

### Patch Changes

- 8ac6eec: Record one store-level owner fingerprint from the resolved intervals.icu athlete identifier at sync time, compare it read-only before credential saves, allow saves when the comparison is unavailable, and keep credential rotation independent from account ownership.
- a6f259c: Add resumable incremental activity-history preparation and materialization while retaining the full Reference layer rebuild as an invariant oracle. Internal operator infrastructure; ships nothing to athletes.
- d22fb9a: User-facing: ChatGPT sign-in now finishes promptly after browser approval, shows clear progress, supports cancellation, and can retry coach activation without another login.
- 4655bd1: Add scriptable CLI verbs with stable JSON output, explicit session selection, daemon-client startup, and a lock-safe local fallback. Public package and image distribution remain unchanged.
- f76081e: Add the internal contract-only terminal surface and lock-owning local dogfood executable composition. Public package and image distribution remain unchanged.
- d36c593: Add the governed Reference layer sync composition root and share the existing Node writer lifecycle. Internal infrastructure; ships nothing to athletes.
- 180df32: Attribute coach store writer failures precisely: recognize write-lock contention across bundle copies by error name, and carry the underlying failure cause through the writer result onto the thrown error.
- e20ada6: Add the internal localhost daemon core, authenticated RPC projection, wall-clock scheduler, and safe newer-store refusal.
- 8619dc3: Reuse the daemon lifecycle's authoritative store writer during refresh windows instead of attempting a nested writer acquisition, so a fresh athlete home starts normally and Reference sync errors render usefully.
- ea56807: Start the local service without an intervals.icu API key by skipping the provider capture lane, and report over-long fence socket paths truthfully instead of as an active handoff reservation.
- 61a8940: Added desktop PKCE sign-in, daemon-owned OAuth profile storage, and keyless runtime configuration for the ChatGPT subscription provider.
- 0115dfe: Preserve closed configuration-readiness failures through app-supervised utility termination without retrying terminal configuration errors.
- b4e5365: Let Desktop start from an existing configuration that omits `data_dir`.
- 78971cb: Adds boundary-scoped archived conversation reads (list plus a cursor-namespaced page reader) through the durable transcript store, daemon RPC registry, main-process IPC, and the validated preload bridge. Current-conversation hydration is untouched; the archived surface has no composer, retry, or resume path. Protocol version moves to 11 because the wire method set grew.
- 1977c1b: Added provider-reported OpenRouter costs and aggregate authenticated spend methods for the desktop client.
- 2e437f8: Add the privileged Desktop Telegram control plane with serialized suspend, resume, and generation-drain authority; truthful mutation outcomes; and one home-bound encrypted token-and-bot profile without exposing token material to the renderer.
- 67369bb: Add an internal append-only transcript writer with a 262,144-byte serialized-record bound and conversation reset boundaries for durable Desktop capture. Renderer history and hydration are not exposed in this slice.
- 810b29e: Add bounded, cursor-stable transcript pagination for the canonical Desktop conversation across the durable store, daemon RPC, main-process IPC, and validated preload bridge.
- d6213bb: Repair daemon socket callback handling, upgrade-fence cleanup, and deterministic socket-suite synchronization.
- 2e437f8: User-facing: Desktop now starts with a fresh Enduragent profile and leaves old npm-library data untouched.

  Removed the obsolete automatic home migrator from local coach startup and made first-run Desktop configuration independent of the old npm home.

- 9f9d8c2: User-facing: Setup now remembers the Claude subscription lane instead of showing Anthropic when you reopen it.

  `credential_configured` was derived from a non-empty `llm.api_key` for every provider except `openai-codex`, so the keyless lanes that never write a key — `claude-cli` and `codex-agent` — were structurally false forever. That nulled the onboarding wizard's active provider, and the Setup draft then fell through to the first entry in the provider catalogue. The runtime check now short-circuits on `isKeylessProvider` and only falls through to the key-length test for providers that actually hold a key. The `openai-codex` branch stays ahead of that short-circuit, so the ChatGPT lane still depends on a stored auth profile rather than reporting itself configured with nothing on disk.

  Populating the active provider exposed a latent assumption in the Settings coach panel: it treated an active provider that is absent from the public model catalogue as an unloadable configuration. `codex-agent` is deliberately absent from the catalogue, so that path became reachable for the first time and would have left those athletes on a dead error screen with no way to switch away. The panel now loads with the provider list intact and no draft selection, and the coach route row reads the active provider off the runtime snapshot instead of the draft, so it no longer reports "Not configured" for a provider that is actually serving turns. An empty catalogue is still a genuine load error.

- 51cd022: Add macOS service installation, status, restart, and fail-closed service-owner arbitration for the internal enduragent executable.
- 00ee9f4: Persist per-source synchronization failures and keep mixed API and FIT activity presentations deterministic.
- e09a645: Project verified curve evidence into a bounded Power Progress training contract with independent freshness, stale-last-good failure context, and no raw provider data.
- 2e437f8: Bind protocol-12 daemon connections to a physical athlete home and give the Desktop renderer a restricted, process-scoped capability instead of the privileged daemon token.
- 68821e7: Add immutable Reference capture sidecars with replayable endpoint evidence and exact live-fetch ordering. Private infrastructure; ships nothing to athletes.
- 3553f83: Add a private Reference layer capture-once gate for store projection.
- 67174e9: Add authenticated intake persistence and in-memory runtime configuration operations to the daemon wire.
- a5b415b: Persist redacted sync-subsystem diagnostics when a scheduled training-store refresh fails.
- 56b2f24: Add a private cycling season review prototype over the configured store-backed coaching path.
- aebc383: User-facing: Desktop ride reviews can now save FIT or GPX files, and the visible training plan can be saved as a ZIP of ZWO, MRC, ERG, or FIT workouts.

  Keep export credentials, provider identifiers, file paths, and downloaded bytes in trusted processes; enforce bounded downloads and atomically publish private mode-0600 files selected through the native save dialog.

- 0afbcad: User-facing: Local coaching can read historical athlete data from the training store and disclose when it was last synchronized.
- Updated dependencies [8ac6eec]
- Updated dependencies [a17fdef]
- Updated dependencies [4f99951]
- Updated dependencies [a6f259c]
- Updated dependencies [e2ef5f7]
- Updated dependencies [ec24061]
- Updated dependencies [d22fb9a]
- Updated dependencies [4655bd1]
- Updated dependencies [f76081e]
- Updated dependencies [fc9ed36]
- Updated dependencies [d36c593]
- Updated dependencies [180df32]
- Updated dependencies [5428c22]
- Updated dependencies [e20ada6]
- Updated dependencies [8619dc3]
- Updated dependencies [68e2a75]
- Updated dependencies [61a8940]
- Updated dependencies [0115dfe]
- Updated dependencies [b4e5365]
- Updated dependencies [78971cb]
- Updated dependencies [a42fb2c]
- Updated dependencies [2e61329]
- Updated dependencies [1977c1b]
- Updated dependencies [2e437f8]
- Updated dependencies [67369bb]
- Updated dependencies [810b29e]
- Updated dependencies [e932ede]
- Updated dependencies [0ab935f]
- Updated dependencies [42c6efa]
- Updated dependencies [a2ac0c4]
- Updated dependencies [517a34f]
- Updated dependencies [c122f29]
- Updated dependencies [111261c]
- Updated dependencies [4e996bc]
- Updated dependencies [66fc866]
- Updated dependencies [b8a8ef0]
- Updated dependencies [0b73876]
- Updated dependencies [51cd022]
- Updated dependencies [00ee9f4]
- Updated dependencies [e09a645]
- Updated dependencies [037a09a]
- Updated dependencies [68821e7]
- Updated dependencies [10c6d16]
- Updated dependencies [9a7961c]
- Updated dependencies [ded6067]
- Updated dependencies [22364df]
- Updated dependencies [67174e9]
- Updated dependencies [0d1ad65]
- Updated dependencies [aebc383]
- Updated dependencies [c0714a0]
- Updated dependencies [336462d]
- Updated dependencies [118c2a6]
- Updated dependencies [89a6522]
- Updated dependencies [0afbcad]
- Updated dependencies [fd9cd3a]
- Updated dependencies [b25c3c1]
- Updated dependencies [edbc0a1]
  - @enduragent/kernel@0.1.0
  - @enduragent/kernel-node@0.1.0
  - @enduragent/coach-contract@0.1.1
  - @enduragent/core@0.1.3
  - @enduragent/sport-cycling@0.0.6
  - @enduragent/coach-cli@0.1.1
  - @enduragent/engine@0.0.2
  - @enduragent/sync-intervals-icu@0.1.0
