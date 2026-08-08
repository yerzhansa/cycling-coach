# @enduragent/coach-contract

## 0.1.1

### Patch Changes

- 4f99951: Add strict shared contracts for bounded activity analysis results.
- d22fb9a: User-facing: ChatGPT sign-in now finishes promptly after browser approval, shows clear progress, supports cancellation, and can retry coach activation without another login.
- fc9ed36: Add the engine/UI contract package: CoachEngine interface, request/response
  schemas, the TurnEvent union with a reserved streaming variant, AthleteState,
  PROTOCOL_VERSION, and CLI exit-code constants. Arm the contract dependency
  gate in the root check chain.
- 61a8940: Added desktop PKCE sign-in, daemon-owned OAuth profile storage, and keyless runtime configuration for the ChatGPT subscription provider.
- 78971cb: Adds boundary-scoped archived conversation reads (list plus a cursor-namespaced page reader) through the durable transcript store, daemon RPC registry, main-process IPC, and the validated preload bridge. Current-conversation hydration is untouched; the archived surface has no composer, retry, or resume path. Protocol version moves to 11 because the wire method set grew.
- 1977c1b: Added provider-reported OpenRouter costs and aggregate authenticated spend methods for the desktop client.
- 2e437f8: Add the privileged Desktop Telegram control plane with serialized suspend, resume, and generation-drain authority; truthful mutation outcomes; and one home-bound encrypted token-and-bot profile without exposing token material to the renderer.
- 810b29e: Add bounded, cursor-stable transcript pagination for the canonical Desktop conversation across the durable store, daemon RPC, main-process IPC, and validated preload bridge.
- e09a645: Project verified curve evidence into a bounded Power Progress training contract with independent freshness, stale-last-good failure context, and no raw provider data.
- 67174e9: Add authenticated intake persistence and in-memory runtime configuration operations to the daemon wire.
- aebc383: User-facing: Desktop ride reviews can now save FIT or GPX files, and the visible training plan can be saved as a ZIP of ZWO, MRC, ERG, or FIT workouts.

  Keep export credentials, provider identifiers, file paths, and downloaded bytes in trusted processes; enforce bounded downloads and atomically publish private mode-0600 files selected through the native save dialog.
