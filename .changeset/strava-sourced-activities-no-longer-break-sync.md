---
"cycling-coach": patch
---

User-facing: Your training history now syncs even when most of your rides came from Strava — the sessions intervals.icu can share are saved instead of the whole sync failing with no data at all.

intervals.icu cannot expose activity detail for Strava-sourced rows under the Strava API Agreement, so it returns a five-key placeholder with no `type`, `moving_time`, `elapsed_time` or streams. The activity index treated a missing `type` as a fatal transport error and aborted the entire pull, so a single placeholder wiped out every other activity in the same window. Placeholder rows are now dropped from the index; rows that do carry a `type` keep the identical strict validation. The `intervals-icu-api` bump to 0.4.0 makes `Activity.type` nullish so the response array parses at all, and the reference sport-adapter dispatcher guards `null` as well as `undefined`.
