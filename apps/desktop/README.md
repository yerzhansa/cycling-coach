# Enduragent desktop

## Open at Login and uninstalling

Turn off **Open at Login** from Enduragent's menu-bar menu before removing the app. macOS can retain an inactive background-items record after unregistering it; Electron may report that record as `not-registered`. This is expected when both login-launch flags are off and does not mean Enduragent will start at login.
