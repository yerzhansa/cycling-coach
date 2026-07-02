---
"cycling-coach": patch
---

User-facing: Long-running deployments now check for updates daily, not only at restart.

Route the existing startup version check through an update endpoint that returns the latest published version and records an anonymous per-instance count. A daily re-check runs alongside the startup check so long-running deployments learn about new releases without a restart; both automatic checks respect `CYCLING_COACH_NO_UPDATE_CHECK`. Dev/test and any endpoint outage fall back to `registry.npmjs.org`, so update checks and notifications keep working.
