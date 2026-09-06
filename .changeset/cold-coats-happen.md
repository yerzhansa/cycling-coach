---
"@enduragent/kernel": patch
"@enduragent/kernel-node": patch
"@enduragent/coach": patch
"@enduragent/desktop": patch
---

Read selected activity files during processing and traverse XML without recursion.

User-facing: Importing a batch of activity files uses less memory. Deeply nested GPX and TCX files no longer interrupt the import with a stack error.
