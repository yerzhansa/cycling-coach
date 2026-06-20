---
"@enduragent/sport-running": minor
"@enduragent/core": patch
---

Serialize structured running workouts and add the calendar-create running tool.

`@enduragent/sport-running` now ships `serializeRunningWorkout` (pace-based steps → intervals.icu native step syntax) plus a gated `intervals_create_workout` tool that writes the workout to the intervals.icu calendar. Steps carry zone, critical-speed-fraction, or absolute-pace targets over time or distance, rendered so the server parses them into a structured workout (distances emit as km/mi so they are never misread as minutes); running Pace Load stays server-authoritative, so no client load is sent. `@enduragent/core` re-exports the critical-speed sanity band (`CS_MIN_MPS` / `CS_MAX_MPS`) as a single constant the running package now derives its band from.
