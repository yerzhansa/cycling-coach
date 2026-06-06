---
"@enduragent/core": patch
---

Add a committed builder for the `capability-qualifying` Reference test fixture
and rebuild it from the refreshed realistic-athlete golden. `tools/build-capability-fixture.ts`
reads the sanitized realistic-athlete base (already id-redacted and shifted to
the synthetic epoch) and appends the five steady-state qualifying Rides at the
tail, mirroring the sibling builders: deterministic plain `JSON.stringify`
output, a committed `.sha256` sidecar, and a non-vacuity guard that recomputes
the durability reliability gate (>= 3 qualifying Rides in the 7d window, >= 5 in
the 28d window) so a vacuous capture fails the build. The rebuild brings the
fixture's 38 base activities onto the current sanitizer field surface (adds the
`icu_hrr` / `icu_variability_index` fields the refresh introduced) while keeping
the appended Rides byte-identical. Folds the fixture into the checksum integrity
test and the PII allowlist scan alongside the other builder-produced goldens.

Internal test-fixture + dev-tooling change; no runtime behavior change.
