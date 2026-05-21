---
"@enduragent/core": patch
---

User-facing: ACWR (load freshness ratio) now computed in the reference layer — the first metric in F8 with bit-identical parity against the upstream protocol.

- Added `packages/core/src/reference/metrics/load-management.ts` with `computeAcwr`. Line-by-line port of `sync.py:3023-3028` + `sync.py:3629-3644` (`_get_daily_tss`). Cites Gabbett 2016 (Br J Sports Med 50:273-280, DOI 10.1136/bjsports-2015-095788) for the underlying acute/chronic load model.
- Registered ACWR in `tools/check-metric-parity.ts`'s `METRIC_REGISTRY`. The gate signature now passes `{ fixture, frozenNow }` to compute functions so date-relative math can match the snapshot anchor.
- Extended `tools/snapshot-section-11.ts` to iterate over an explicit `HARNESS_FIXTURES` allowlist (realistic-athlete + new-athlete-empty + data-gap-mid-history), with per-fixture `frozenNow`. Fixtures owned by other test suites (F7 reference substrate's `post-break-resume`, `zero-activities`) live alongside but are intentionally excluded from the snapshot harness.
- New golden fixtures:
  - `new-athlete-empty.json` — zero activities, zero wellness, zero ftp_history; forces every "no data" branch (ACWR returns `null` from `chronic_load <= 0`).
  - `data-gap-mid-history.json` — 21 activities split by a 28-day gap; the resumed week populates the acute window while chronic is mostly depleted, so ACWR resolves to 3.51 (above-1.5 spike territory).
- Bit-identical parity holds across all 3 fixtures: `pnpm check-parity --metric=acwr --fixture=all` exits 0 with `0.81 / null / 3.51`.

No deviation registered in `tools/intentional-deviations.yaml` — ACWR is a faithful transliteration. Discipline: `docs/adr/0016-metric-porting-discipline.md`.
