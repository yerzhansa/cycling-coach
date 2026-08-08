# @enduragent/desktop

## 0.1.0

### Minor Changes

- Start the independent desktop SemVer sequence and bind packaged application identity, update metadata, signed artifacts, and native update acceptance to that version.

## 0.0.3

### Patch Changes

- 718e34e: Add a one-time, fail-closed macOS release genesis path that proves the signed, notarized updater envelope without weakening routine baseline continuity checks.

## 0.0.2

### Patch Changes

- d22fb9a: User-facing: ChatGPT sign-in now finishes promptly after browser approval, shows clear progress, supports cancellation, and can retry coach activation without another login.
- 0115dfe: Preserve closed configuration-readiness failures through app-supervised utility termination without retrying terminal configuration errors.
- b4e5365: Let Desktop start from an existing configuration that omits `data_dir`.
- 78971cb: Adds boundary-scoped archived conversation reads (list plus a cursor-namespaced page reader) through the durable transcript store, daemon RPC registry, main-process IPC, and the validated preload bridge. Current-conversation hydration is untouched; the archived surface has no composer, retry, or resume path. Protocol version moves to 11 because the wire method set grew.
- 2e61329: Add curated and custom model selection, write-only endpoint overrides, explicit provider activation, and retry-safe non-secret Setup drafts.
- 2e437f8: Add the privileged Desktop Telegram control plane with serialized suspend, resume, and generation-drain authority; truthful mutation outcomes; and one home-bound encrypted token-and-bot profile without exposing token material to the renderer.
- 2e437f8: User-facing: Added an optional Desktop-hosted Telegram bot with private pairing, local-only availability, and separate Telegram chat history.

  Added main-only clipboard capture, a strict redacted mutation contract, a coherent encrypted bot profile, visible replacement controls, background startup, transient sleep/resume handling, and generation-drained token replacement for Desktop Telegram setup.

- 810b29e: Add bounded, cursor-stable transcript pagination for the canonical Desktop conversation across the durable store, daemon RPC, main-process IPC, and validated preload bridge.
- 2e437f8: User-facing: Desktop now starts with a fresh Enduragent profile and leaves old npm-library data untouched.

  Removed the obsolete automatic home migrator from local coach startup and made first-run Desktop configuration independent of the old npm home.

- d1e548d: Read intervals.icu credentials live in Reference layer sync so automatic training-data sync picks up a key entered during Desktop onboarding.
- 1fd7ebc: User-facing: Fixed Desktop Telegram turning itself back on after the user chose Turn off.

  Treat the stored power choice as authoritative across status polling, reconciliation, restart recovery, pairing cancellation, and pairing-lease races while preserving the configured bot and paired primary user for a later explicit Turn on.

- 24437a7: User-facing: Telegram setup now explains how to recover when secure token storage or Keychain access is unavailable without changing the current bot.

  Preserve closed secure-storage refusal reasons across the Desktop process boundary, refuse unencrypted token storage, and emit stage-and-reason-only local diagnostics without exposing credential details.

- Updated dependencies [8ac6eec]
- Updated dependencies [4f99951]
- Updated dependencies [a6f259c]
- Updated dependencies [ec24061]
- Updated dependencies [d22fb9a]
- Updated dependencies [4655bd1]
- Updated dependencies [f76081e]
- Updated dependencies [fc9ed36]
- Updated dependencies [d36c593]
- Updated dependencies [180df32]
- Updated dependencies [e20ada6]
- Updated dependencies [8619dc3]
- Updated dependencies [ea56807]
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
- Updated dependencies [d6213bb]
- Updated dependencies [2e437f8]
- Updated dependencies [517a34f]
- Updated dependencies [9f9d8c2]
- Updated dependencies [51cd022]
- Updated dependencies [00ee9f4]
- Updated dependencies [e09a645]
- Updated dependencies [2e437f8]
- Updated dependencies [037a09a]
- Updated dependencies [68821e7]
- Updated dependencies [3553f83]
- Updated dependencies [10c6d16]
- Updated dependencies [9a7961c]
- Updated dependencies [22364df]
- Updated dependencies [67174e9]
- Updated dependencies [0d1ad65]
- Updated dependencies [a5b415b]
- Updated dependencies [56b2f24]
- Updated dependencies [aebc383]
- Updated dependencies [118c2a6]
- Updated dependencies [89a6522]
- Updated dependencies [0afbcad]
- Updated dependencies [b25c3c1]
  - @enduragent/coach@0.1.0
  - @enduragent/coach-contract@0.1.1
  - @enduragent/core@0.1.3
  - @enduragent/coach-client@0.1.1
