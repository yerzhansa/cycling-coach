---
"cycling-coach": patch
---

User-facing: ChatGPT sign-in now keeps working on machines with a wrong clock, and sign-in problems show up as authentication errors instead of a generic failure.

Token validity no longer depends on the local wall clock: the ChatGPT-lane token readers return the stored access token as-is and treat a server 401 as the only invalid signal, with one bounded refresh-and-retry per generation (MAX_AUTH_REFRESH_ATTEMPTS = 1). HTTP 401/403 from the provider is classified as error_class "auth" in turn_outcome. Coaching dates and daily resets intentionally stay on the local clock.
