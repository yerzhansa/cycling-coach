# Enduragent desktop

## Releases and updates

The desktop app uses its own SemVer from `apps/desktop/package.json` and releases under `enduragent-desktop@<version>`; desktop releases never publish or bump the npm package. The protected macOS workflow signs with Developer ID, notarizes with Apple, verifies the DMG, ZIP, blockmap, and `latest-mac.yml`, runs the signed update round trip, and makes the tested release the updater feed only after those checks pass.

## Open at Login and uninstalling

Turn off **Open at Login** from Enduragent's menu-bar menu before removing the app. macOS can retain an inactive background-items record after unregistering it; Electron may report that record as `not-registered`. This is expected when both login-launch flags are off and does not mean Enduragent will start at login.
