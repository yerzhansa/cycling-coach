# Cache-economics soak report — <YYYY-MM-DD>

Status: FILLED-IN | Soak window: <start ISO> .. <end ISO> (<N> days)

## Setup

- Desktop-branch commit(s) running during the soak: <git SHAs>
- Chat route: <provider> / <model> (breakpoint-capable: yes)
- Background-role route(s): <provider> / <model>
- Bot-token decision: <Option A — hosted poller stopped | Option B — dedicated dogfood token> because <one line>
- Data-dir source: <default | CYCLING_COACH_HOME | --data-dir>
- Analyzer invocation: `pnpm usage:cache-band --since <ISO> [--price ...]`

## Measured band metrics (paste the tool's --json output)

```json
<paste BandReport JSON here — aggregates only; never raw ledger lines>
```

## Band verdict

- Cache-read ratio (chat role, breakpoint-capable routes): <ratio> vs band >= 60% → <pass/fail>
- Projected daily cost (all generations, token-recomputed): $<x>/day vs band <= $0.25/day → <pass/fail>
- **VERDICT: <PASS | REPRICE | UNDETERMINED>**
- If REPRICE: the product cost story is repriced to the measured $<x>/day; the cache work itself is NOT rolled back.

## Multi-step cache evidence

<multiStepLinesWithCacheRead> of <multiStepLines> multi-step chat generations on breakpoint-capable
routes carried cache-read tokens. Caveat: the ledger aggregates a whole multi-step call into one
line, so this infers (not proves) cache reads on steps 2..N; a step-1 warm-prefix read is
indistinguishable in this data.

## Notes

- Gaps/cold days during the soak: <...>
- Anything that would bias the number (travel, unusually chatty week, model switch mid-soak): <...>
- The $0.08/day headline is a best-case bound; this report's number is the measured one.

## Follow-ups

- <e.g. price-catalog entry missing for the chat route; propose adding it>
