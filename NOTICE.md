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

---

## @mariozechner/pi-ai

The ChatGPT-subscription ("openai-codex") provider under
`packages/core/src/agent/codex/` — OAuth login + token refresh (`oauth.ts`),
the JWT account-id helper (`jwt.ts`), the Responses-API round-trip
(`responses.ts`), and the per-million pricing catalog (`cost.ts`) — is adapted
from [`@mariozechner/pi-ai`](https://www.npmjs.com/package/@mariozechner/pi-ai)
v0.67.6 by Mario Zechner, distributed under the MIT License.

### Original license (verbatim)

```
MIT License

Copyright (c) Mario Zechner

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

### Modifications introduced

The codex provider is not a verbatim copy; it was re-expressed in this
codebase's own type vocabulary and trimmed to what the coach needs:

- **AI-SDK types throughout.** The provider consumes/produces the Vercel AI SDK
  `ModelMessage[]` / `LanguageModelUsage` shapes used by every other provider,
  rather than pi-ai's parallel `Context` / `AssistantMessage` / `Usage` types.
  The single message↔wire conversion is folded into `responses.ts`.
- **SSE transport only.** The WebSocket transport and its session-connection
  cache are dropped; the coach collapses each reply to a single message.
- **No internal retry loop.** Retry/backoff is owned by the agent's shared
  retry primitive; the provider performs exactly one request attempt and throws
  structured errors (`httpStatus` / `retryAfterMs`, or a raw network throw with
  its errno cause) for the outer loop to classify.
- **Native token-endpoint redaction.** Failed token exchange/refresh logs only
  the HTTP status and a boolean field-presence object — never response bodies or
  token JSON. (This replaces a previously-maintained dependency patch.)
- **Client identification.** The Responses request `originator` header is
  `codex` and the `User-Agent` product token is `cycling-coach`.
- **Pricing as a static snapshot.** `cost.ts` carries a per-million price table
  for the priced providers, extracted from pi-ai's generated model catalog at
  v0.67.6; a table miss yields no cost rather than a fabricated figure.
- **Text-only message scope.** The coach is a text chat agent, so the
  message↔wire conversion handles text content only; pi-ai's `input_image`
  emission for image/file content parts (in user messages and tool results) is
  not carried over.
- **Strict tool-argument parsing.** Final tool-call arguments are parsed with a
  strict `JSON.parse` (no `partial-json` tolerant fallback). Malformed or
  truncated arguments collapse to `{}`, so the tool's own schema validation
  rejects the call cleanly rather than the model executing on a best-effort
  partial object — preferable for a write-capable coach.
