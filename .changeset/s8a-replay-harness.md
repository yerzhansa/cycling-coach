---
"@enduragent/core": patch
---

Deterministic replay gate for agent-turn behavior: `pnpm s8a` replays committed
mocked-LLM scenarios and asserts prompt hashes, tool-call sequences and arguments,
message-array shape, memory and ledger writes, and budget charges against recorded
baselines; `pnpm s8a --self-test` proves the gate can fail via a seeded-drift fixture
and a determinism probe. Runs offline in CI on every push and PR.

Pure-infra changeset.
