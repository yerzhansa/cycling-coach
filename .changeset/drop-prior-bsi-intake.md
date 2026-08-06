---
"cycling-coach": patch
---

User-facing: Setup no longer asks whether you have had a bone stress injury — the clinician-clearance question now appears only when you are managing or returning from an injury.

The flag was collected, validated and stored but never read: nothing fed it into the coach
prompt or any ride-volume logic, so its "affects how quickly we build volume" subtitle
described behaviour that did not exist. The cycling-only setup now asks only about an injury
the athlete is currently managing or returning from.

The clearance question now keys off `injury_status` alone. It still requires an answer from
anyone managing or returning from an injury; it no longer appears for a historical injury with
no current return-to-training context. The pre-release store schema no longer carries the unused
field. Protocol 11 retains it only as an ignored compatibility value, with the new client always
sending `false`. The footer note names the one question that is outstanding.
