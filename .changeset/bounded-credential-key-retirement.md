---
"@enduragent/desktop": patch
---

User-facing: Prevented unsafe credential files or a changed macOS Keychain key from making saved credentials unreadable.

Automatic key retirement now requires a bounded, stable cross-vault census, and every credential write revalidates the persisted key without user interaction.
