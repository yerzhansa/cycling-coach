# Settings connections

## What it covers

- Owned surface and user route: **Settings** in Main navigation (`activeView: "settings"`). `SettingsView` renders the embedded **Setup**, **Telegram**, **Coach**, and **Training account** connection surfaces; this page is not a complete Settings inventory.
- Coach and training scenario-map rows: `settings.providers.coach-route`, `settings.providers.credential-management`, `settings.intervals.connect`, `settings.intervals.delete-only`, and `settings.training-account.identity`.
- Telegram scenario-map rows: `settings.telegram.delete-only`, `telegram.setup.clipboard-connect`, `telegram.setup.refusal-recovery`, `telegram.connection.delete-only`, `telegram.pairing.webhook-removal`, `telegram.pairing.primary-user`, `telegram.allowed-senders.management`, and `telegram.lifecycle.turn-off-on`.
- Supported executors: renderer `vitest` for executable Settings behavior and desktop `vitest` for frozen scenario-map validation.

## How to get to it (user POV)

- Complete Setup, then choose **Settings** in Main navigation. Use [`setup.md`](setup.md) for the full-window gate, readiness, local ride-file import, and completion behavior.
- In **Setup**, change what powers the coach, manage saved provider credentials, or connect/delete Intervals.icu; **Training account** shows the connected athlete identity and routes missing-credential recovery back to Setup.
- In **Telegram**, connect a dedicated BotFather bot from the clipboard, remove a webhook if requested, pair the primary user, manage additional allowed users, turn the connection off or on, or delete it locally.

## Driving it with verify-enduragent

```bash
pnpm --filter @enduragent/desktop-renderer exec vitest run tests/settings-surface.test.tsx tests/credential-settings.test.ts tests/athlete-settings.test.ts tests/telegram-settings.test.ts tests/telegram-settings-surface.test.tsx
pnpm --filter @enduragent/desktop exec vitest run tests/windows-parity-scenarios.test.ts
```

Require the renderer run to show Setup first, save a coach provider/model route, distinguish active and saved-not-in-use credentials, confirmation-gate local deletion, preserve and authoritatively reread athlete identity, keep secrets out of rendered fields, and expose truthful Telegram setup, pairing, allowed-user, on/off, recovery, and deletion states.

The desktop command validates the frozen manifests and that deterministic rows cite existing test names; it does not execute the mapped Settings behavior.

## Gotchas

- Renderer tests use isolated state and mocked bridges. They do not exercise real provider or Intervals.icu credentials, local file selection/import, BotFather or Telegram networking, the OS clipboard, secure credential storage, or the Telegram daemon.
- Real Intervals.icu and Telegram connections require valid copied credentials and available OS secure storage; coach lanes may instead require browser sign-in, Claude CLI state, or a provider API key. Connection deletion is local; provider accounts, Telegram bots/chats, synced rides, and past chats follow the user-visible retention copy.
- `settings.windows.credential-wording`, `telegram.windows.setup-copy-storage`, `telegram.windows.packaged-connectivity`, and `telegram.windows.packaged-lifecycle` are `vm-only` and require an installed Windows VM plus manual credential, clipboard, network, and lifecycle checks.
- No Settings-connections-owned Playwright, CDP, S8A, or native Windows automated flow is proved by these tests or manifests.
