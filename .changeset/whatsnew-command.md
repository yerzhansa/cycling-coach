---
"cycling-coach": patch
---

User-facing: Added /whatsnew — see what changed in the latest version without leaving Telegram.
User-facing: Update notifications now point to /whatsnew so you can decide whether to /update.

Adds a new `/whatsnew` command that fetches the latest GitHub Release body for the running binary and renders only the lines tagged `User-facing:` in the underlying changesets. Engineering details, hashes, and infra-only changesets stay in `CHANGELOG.md` for git history but never reach athletes.

Convention is documented in `.changeset/README.md`. The bot makes one anonymous GitHub API call per `/whatsnew` invocation (no caching); GitHub Releases are auto-created by `release.yml` so no extra release-process work is needed.
