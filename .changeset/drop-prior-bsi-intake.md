---
"cycling-coach": patch
---

User-facing: Setup no longer asks whether you have had a bone stress injury — injury status alone decides whether clinician clearance is needed.

The flag was collected, validated and stored but never read: nothing fed it into the coach
prompt or any volume logic, so its "affects how quickly we build volume" subtitle described
behaviour that did not exist. It arrived with the multisport intake block, whose swim fields
are already pinned to null for the cycling-only scope, and bone stress injury is an
impact-loading risk factor that does not transfer to non-weight-bearing riding.

Clinician clearance now keys off `injury_status` alone. The gate still fires for anyone
managing or returning from an injury; it no longer fires for a healed history with no current
injury. Migration 009 drops the column, `SaveIntakeRpcParams` drops the field and rejects it as
an unknown key, and the footer note names the one question that is actually outstanding.
