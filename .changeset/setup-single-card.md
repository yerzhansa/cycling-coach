---
"cycling-coach": patch
---

User-facing: Setup is now one screen — choose what powers your coach, connect intervals.icu, answer the injury questions, and start coaching, instead of a four-step wizard.

Setup is rebuilt as a single `Page` holding one bordered card of divider-separated rows: an AI row that behaves like a native popup button, its ChatGPT and API-key sub-panels, an intervals.icu row that edits in place, and the three intake rows. The four-step machine is unchanged and is now run as an internal ordered gate walk by a single `finish()` action, so nothing can complete with a missing provider, missing training data, or an incomplete intake.

Supporting changes: the credential-draft harvest takes an explicit slot filter so a model-key save can never write the intervals.icu secret; readiness is computed once in the controller and published on the surface; the popup and the two information affordances use Base UI (`Menu`, `Tooltip`) instead of hand-rolled keyboard and focus handling; the whole onboarding surface is Tailwind-only and its CSS module is deleted.
