---
"@enduragent/kernel": patch
"@enduragent/kernel-node": patch
---

Add the content-addressed raw-archive manager to the pure kernel and its Node
host adapter: content-addressed artifact writes, gzipped canonical-JSON payload
snapshots, quarantine routing for unparseable inputs, and a structurally
never-delete, archive-first write surface behind the injected Crypto and
FileSystem ports.
