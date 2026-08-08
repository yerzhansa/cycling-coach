# @enduragent/coach-client

## 0.1.1

### Patch Changes

- 61a8940: Added desktop PKCE sign-in, daemon-owned OAuth profile storage, and keyless runtime configuration for the ChatGPT subscription provider.
- 78971cb: Adds boundary-scoped archived conversation reads (list plus a cursor-namespaced page reader) through the durable transcript store, daemon RPC registry, main-process IPC, and the validated preload bridge. Current-conversation hydration is untouched; the archived surface has no composer, retry, or resume path. Protocol version moves to 11 because the wire method set grew.
- 1977c1b: Added provider-reported OpenRouter costs and aggregate authenticated spend methods for the desktop client.
- 2e437f8: Add the privileged Desktop Telegram control plane with serialized suspend, resume, and generation-drain authority; truthful mutation outcomes; and one home-bound encrypted token-and-bot profile without exposing token material to the renderer.
- 810b29e: Add bounded, cursor-stable transcript pagination for the canonical Desktop conversation across the durable store, daemon RPC, main-process IPC, and validated preload bridge.
- aebc383: User-facing: Desktop ride reviews can now save FIT or GPX files, and the visible training plan can be saved as a ZIP of ZWO, MRC, ERG, or FIT workouts.

  Keep export credentials, provider identifiers, file paths, and downloaded bytes in trusted processes; enforce bounded downloads and atomically publish private mode-0600 files selected through the native save dialog.

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
