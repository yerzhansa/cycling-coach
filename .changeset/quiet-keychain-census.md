---
"@enduragent/desktop": patch
---

User-facing: Prevented unsafe credential-key replacement when local credential files cannot be inspected consistently.

The macOS binding now scopes every key operation to the default Keychain and deletes only the exact validated Enduragent item. A failed envelope inspection no longer masquerades as a pending key deletion during recovery. Automatic key retirement now syncs both vault directories before proving that no dependent envelope survives. Ordinary credential removal revalidates the exact Keychain key without creating a replacement, a missing-key recovery state now offers a non-creating Retry action, and an explicitly removed legacy Telegram envelope no longer requires a missing custom key.
