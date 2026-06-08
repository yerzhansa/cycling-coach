---
"@enduragent/core": patch
---

Stop the single-fixture debug snapshot regen from clobbering the manifest. The
`SNAPSHOT_FIXTURE_PATH` debug path processes one fixture but used to rewrite
`manifest.json` from that single slug — silently dropping every other fixture
from the index (their snapshot files on disk untouched, only the manifest lied)
and collapsing the metric union down to the one fixture's metrics. The debug
path now MERGE-patches instead: it unions the processed slug into the existing
fixtures + metrics lists and preserves the rest, leaving a manifest byte-identical
to a full regen. It refuses loudly (non-zero exit) when no manifest exists yet
(a debug regen presumes an initialized snapshot tree) or when the existing
manifest's oracle coordinates — upstream sha / protocol version / commit date /
pyodide version — diverge from the current toolchain, so a stale-coordinate
partial manifest can't land. The manifest builders are extracted into their own
module and unit-tested, including a hermetic byte-identity gate that reconstructs
the committed manifest from the on-disk snapshot tree without booting the WASM
oracle; the full-regen path's manifest output is preserved byte-identical. The
snapshot-index smoke test now asserts the full fixture allowlist rather than a
single slug, closing the asymmetric hole where a debug regen of that one named
slug would corrupt the index unasserted.

Pure dev-time + oracle infra — athletes don't notice.
