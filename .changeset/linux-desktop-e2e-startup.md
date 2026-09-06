---
"@enduragent/desktop": patch
"cycling-coach": patch
---

User-facing: On Linux, Enduragent now starts its local service itself when none is running instead of reporting that it could not reach the service.

Registration reads treat Linux like Windows: app-supervised with no launchd registration, unless a caller supplies an explicit registration state. The isolated development profile binding also accepts Linux, so the Linux desktop E2E job runs the same startup path as the packaged macOS fixture.
