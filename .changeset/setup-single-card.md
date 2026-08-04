---
"cycling-coach": patch
---

User-facing: Setup is now one screen — choose what powers your coach, connect intervals.icu, answer the injury questions, and start coaching, instead of a four-step wizard.

Setup is rebuilt as a single `Page` holding one bordered card of divider-separated rows: an AI row that behaves like a native popup button, its ChatGPT and API-key sub-panels, an intervals.icu row that edits in place, an injury-status row, and a clinician-clearance row when the athlete is managing or returning from an injury. A single controller readiness projection gates `finish()` directly. Completion requires an active provider, usable training data, and a complete intake.

Supporting changes: the credential-draft harvest takes an explicit slot filter so a model-key save can never write the intervals.icu secret; readiness is computed once in the controller and published on the surface; the popup and the two information affordances use Base UI (`Menu`, `Tooltip`) instead of hand-rolled keyboard and focus handling; the whole onboarding surface is Tailwind-only and its CSS module is deleted.
