---
"cycling-coach": patch
---

User-facing: Added /review — get a coaching review of your last training session, with depth that auto-scales by activity type.
User-facing: Use /review deep for race-style analysis or /review brief for a quick check; you can also pass natural language like /review my saturday ride.

Adds two Pure-Core intervals.icu tools (`intervals_fetch_activity` and `intervals_fetch_streams`) so the agent can pull per-rep splits and raw streams when it needs them, plus a `WORKOUT_REVIEW_RULES` system-prompt block that drives the 3-questions framework, depth tiers (Tier A ~50 words / Tier B ~200 / Tier C ~500–600), the `Reply 'show numbers'` + `/review deep` footer, and the trademark cleanup (no NP/CTL/ATL/IF/TSS/TSB or "true FTP" in athlete-facing review output — uses Load / Intensity / Fitness / Fatigue / Form / weighted avg power instead). Cycling-specific guidance lives in `sport-cycling/SOUL.md` (30-min activity-clustering rule, jargon list, substitution table) and `sport-cycling/skills/review.md` (decoupling thresholds, best-efforts duration ladder, fade-pattern catalog, indoor-vs-outdoor signals).
