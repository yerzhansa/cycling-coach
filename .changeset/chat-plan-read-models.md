---
"@enduragent/desktop": patch
---

User-facing: Added a read-only Plan destination and current Plan details to Chat’s Training context.

Planning now owns the strict current-Plan, current-week, and Workout projection used by Desktop; Chat can navigate to the relevant Plan context but cannot mutate Plan data.
