# Enduragent desktop

## Releases and updates

The desktop app uses its own SemVer from `apps/desktop/package.json` and releases under `enduragent-desktop@<version>`; desktop releases never publish or bump the npm package. The protected macOS workflow signs with Developer ID, notarizes with Apple, verifies the DMG, ZIP, blockmap, and `latest-mac.yml`, runs the signed update round trip, and makes the tested release the updater feed only after those checks pass.

## Windows

Windows targets Windows 11 x64 with the per-user, one-click `Enduragent-<version>-x64.exe` installer, its `.blockmap`, and `latest.yml`; the installer requests no elevation, adds a Start Menu shortcut but no desktop shortcut, and ships only with an Authenticode signature from `<PUBLISHER_NAME>`, although SmartScreen can still prompt while a new publisher identity builds reputation. Windows assets are appended to the existing desktop release, may lag or skip a version, and never hold the macOS release; update checks use the same generic GitHub release feed and switch on with the first signed release. Closing the main window keeps the app running in the tray until it is explicitly quit, while uninstalling retains `%LOCALAPPDATA%\Enduragent` for the athlete to remove by hand. Follow the operator runbook in `CONTRIBUTING.md`.

## Open at Login and uninstalling

Turn off **Open at Login** from Enduragent's menu-bar menu before removing the app. macOS can retain an inactive background-items record after unregistering it; Electron may report that record as `not-registered`. This is expected when both login-launch flags are off and does not mean Enduragent will start at login.
