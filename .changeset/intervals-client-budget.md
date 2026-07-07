---
"cycling-coach": patch
---

User-facing: Chat requests to intervals.icu now time out after 30 seconds instead of hanging a coach turn indefinitely.

Route every intervals.icu client built by the factory (sync and chat) through one process-wide request bucket (10 requests/second, burst 30) so multiple clients can no longer burst past the intended combined pacing. Chat clients now get the same abortable per-request timeout wrapper as sync clients; the timeout covers queue wait plus the HTTP call, queued waits abort promptly, and lib-level retries stay disabled (`maxAttempts: 1`) on both paths.
