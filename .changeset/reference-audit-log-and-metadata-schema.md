---
"@enduragent/core": patch
---

Add the Reference layer's recommendation-metadata + audit-log substrate. Two
new `.strict()` Zod schemas — `RecommendationMetadata` (the citations /
confidence / frameworks / phase-tag contract every coaching reply carries) and
`AuditLogEntry` (the on-disk `.audit.jsonl` line shape) — plus an
`AUDIT_SCHEMA_VERSION` constant. The writer (`writeAuditEntry`) atomic-appends
one compact JSONL line per reply via `open(path, "a")` (O_APPEND), creating the
data dir on first write; it is best-effort and never throws, warning per
failure and escalating once via `console.error` after 10 cumulative failures in
a session. The parser (`parseAuditLog`) streams the log, dispatches on
`schema_version` before the schema parse, and is robust to manual corruption —
malformed JSON and unknown-version lines are skipped with a warn, a missing
file yields an empty iterable. `computeResponseHash` derives the 16-char reply
fingerprint stored on each entry.

Trust-substrate only — this ships the schema + writer/parser but does not yet
wire them into the live reply path. Athletes notice nothing until a later wave
plumbs the writer into the coaching turn.
