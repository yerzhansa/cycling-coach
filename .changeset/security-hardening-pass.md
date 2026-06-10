---
"@enduragent/core": patch
"cycling-coach": patch
---

User-facing: Operator pairing now requires sending a one-time code shown in your terminal, so a stranger racing you to the bot during setup can no longer claim ownership.
User-facing: /update now installs the exact version it verified against the registry, with dependency install scripts disabled.
User-facing: Health data, session transcripts, and memory files are now written owner-only (0600 files in 0700 directories) on every deployment path, and old session archives are pruned automatically.
User-facing: The automatic startup update check can be disabled with CYCLING_COACH_NO_UPDATE_CHECK=1; it is now disclosed in the README's privacy section.
User-facing: Running with CYCLING_COACH_DM_POLICY=open now prints a loud startup warning and logs each non-allowlisted sender it serves.

Security-hardening pass across the bot's trust boundaries:

- File permissions: all JSON/JSONL/markdown writers create files 0600 and data
  directories 0700; the data-dir tightening that previously ran only on
  allowlist writes is now an unconditional startup invariant; pre-existing
  world-readable files are tightened on rewrite. Session reset archives are
  capped at the newest 20 per chat.
- Telegram output: raw reply text is HTML-escaped before markdown conversion
  (only converter-emitted tags survive), and a reply that Telegram rejects for
  entity-parse errors is retried as plain text instead of being dropped.
- Prompt-injection containment: athlete memory is fenced in the system prompt
  as data-not-instructions, an untrusted-data handling rule covers tool
  results, and the codex-bridge tool loop now validates tool arguments against
  their schema before execution (parity with the AI SDK providers).
- OAuth: refresh failures retry once before being classified as token reuse,
  refreshes are serialized per profile, profile writes are atomic, and the
  pinned pi-ai dependency is patched to stop logging token-endpoint response
  bodies on malformed responses.
- Operator capture: pairing-code gated, queued pre-start updates dropped,
  capture confirmations default to decline on bare Enter.
- Setup wizard: secret storage defaults to a detected keychain/1Password
  backend instead of plaintext; config dir/file permissions tightened on
  re-run.
- Supply chain: GitHub Actions pinned to commit SHAs with Dependabot coverage,
  Docker base images pinned by digest, the container runs as the non-root
  node user, corepack's pnpm download is integrity-pinned, and the privacy
  lint now scans .changeset and root markdown surfaces.
