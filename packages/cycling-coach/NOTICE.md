# Notices and Attributions

This file lists upstream projects whose code or design Cycling Coach (and the
broader `enduragent` workspace) carries, along with the licenses they were
distributed under and the modifications introduced during the port.

---

## section-11

Cycling Coach's **Reference** submodule (the data + sport-aware adapter
substrate that grounds coaching in verified athlete numerics) is a port of
[section-11](https://github.com/CrankAddict/section-11) by CrankAddict,
specifically protocol v11.43, released under the MIT License.

### Original license (verbatim)

```
MIT License

Copyright (c) 2026 CrankAddict

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Modifications introduced in this port

The Reference submodule (`packages/core/src/reference/`) is not a verbatim
copy; the following modifications were applied during the port:

- **Trademark substitution.** Section-11 was authored against TrainingPeaks
  vocabulary. This codebase uses intervals.icu's plain-English alternatives
  throughout — the substitution is enforced by `pnpm check:trademarks` and
  documented in [`CONTRIBUTING.md`](./CONTRIBUTING.md#trademark-hygiene).
- **Multi-sport adapter pattern.** Per ADR-0010, the Reference layer gains a
  per-sport seam — sports plug in via an optional `referenceAdapters?()`
  method on the `Sport` interface, returning an array of layer-owned adapters
  with declarative metadata plus optional algorithm hooks (e.g.,
  `computeDfa`, `computePowerCurve`). Section-11's single-sport design is
  preserved as the cycling adapter; running and duathlon compose via the
  same seam.
- **Zod-strict schemas as drift gate.** Every cache file (`latest.json`,
  `history.json`, `intervals.json`, `routes.json`, `ftp_history.json`,
  `.scheduler.json`, `error_state.json`) is parsed through a `.strict()` Zod
  schema. Forgotten-field drift fails loudly instead of silently dropping
  data; a unit test enumerates every schema and asserts strictness.
- **Mutex / cooldown discipline for sync.** A single mutex-protected
  `runSync()` orchestrates scheduled, lazy-fallback, and `/sync`-triggered
  refreshes with a 30 s acquire timeout, 2 min outer timeout, and 30 s
  per-chat cooldown. The orchestrator lives at
  `packages/core/src/reference/sync/run-sync.ts`; the underlying
  primitives (`AsyncMutex`, `chainedSignal`, `Cooldown`) live in
  `packages/core/src/concurrency/` and are reused unchanged by future
  horizontal layers (Decision Layer, Heartbeat, Coaching Loop) per
  ADR-0011.
- **Three-layer validation.** Layer 1 sync gate (mechanical), Layer 2
  Zod-validated LLM output with one retry on citation mismatch, Layer 3
  prompt rules.
- **Display-units conversion at prompt-injection time.** Canonical metric on
  disk; `formatQuantity(quantity, athleteUnits)` renders to the athlete's
  preferred system. Section-11's mixed-units assumptions are removed.

### Canonical attribution surfaces

This file (`NOTICE.md`) and the [`README.md` Credits section](./README.md#credits)
are the canonical attribution surfaces. The full upstream repository is at
https://github.com/CrankAddict/section-11.
