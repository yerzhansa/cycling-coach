# Enduragent Desktop Features

| Feature | Page |
|---|---|
| Chat and past chats | [`chat-history.md`](chat-history.md) |
| Setup | [`setup.md`](setup.md) |
| Settings connections | [`settings-connections.md`](settings-connections.md) — Settings-owned coach, Intervals.icu/training-account, and Telegram connection management use deterministic renderer `vitest`; native Windows rows are `vm-only`. |
| Shell lifecycle | [`shell-lifecycle.md`](shell-lifecycle.md) — launch, window, tray, and quit scenarios use desktop/renderer `vitest`, an isolated Playwright launch fixture, and `vm-only` native Windows rows. |
| Training | [`training.md`](training.md) — deterministic Training scenarios use isolated `ready()` renderer state with renderer/desktop `vitest`; native Windows rows are `vm-only`. |
