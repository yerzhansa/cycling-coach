---
"cycling-coach": patch
---

User-facing: The desktop app no longer triggers macOS prompts asking for your music library or your Desktop folder.

Two unrelated causes, both incidental rather than intentional access.

Chromium registers with the macOS Now Playing / media-key integration on startup, which macOS reports as a media-library access request even though the app has no audio surface at all. `disableChromiumMediaSessionIntegration()` appends `MediaSessionService` and `HardwareMediaKeyHandling` to Chromium's `disable-features`, merging with Electron's own defaults rather than replacing them.

The ride-file chooser called `showOpenDialog` without a `defaultPath`, so the non-sandboxed `NSOpenPanel` opened at the system default — the Desktop — and the app itself was the accessing process. The chooser now opens at the home root, which is not a protected location. Navigating into Desktop or Documents still asks, which is the correct consent-in-context behaviour.

Neither the app nor its entitlements ever requested this access; the prompts became visible only because code signing changed the app's privacy identity.
