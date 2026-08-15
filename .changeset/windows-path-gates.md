---
"cycling-coach": patch
---

User-facing: Exporting a ride and importing ride files now work on Windows. Both used to fail with "The export could not be saved to that location" because every Windows path was rejected before anything was read or written.

Export destinations and import paths now share one platform-absolute path validator that accepts POSIX, drive-letter and UNC paths; the preload and renderer import gates parse extensions across both separators; the export writer joins its temporary path with the platform separator and skips the post-rename directory fsync on Windows, where directory handles cannot be synced; and desktop export IPC now logs a fixed failure-stage classification before reporting a write failure.
