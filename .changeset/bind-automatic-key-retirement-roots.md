---
"@enduragent/desktop": patch
---

User-facing: Prevented Enduragent from deleting its encryption key when credential storage cannot be safely inspected.

Credential envelope scans now bind both vault roots before automatic Keychain key retirement and
fail closed when either root is unsafe or changes during the scan.
