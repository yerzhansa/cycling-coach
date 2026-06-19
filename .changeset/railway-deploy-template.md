---
"cycling-coach": patch
---

User-facing: Added a one-click Railway deploy template so you can spin up your own private, single-tenant instance — your own bot, your own keys, your own data — in a few clicks.
User-facing: In managed container deploys, /update now explains that the bot updates by redeploying the image instead of attempting an install that can't succeed there.

Ships the Railway distribution channel: a `railway.toml` (Dockerfile builder, crash-restart policy, no inbound healthcheck for the long-polling worker) and a Deploy button in the README. Gates the self-update path behind a `CYCLING_COACH_MANAGED_DEPLOY` flag baked into the runtime image so `/update` and the startup broadcast give redeploy guidance instead of running `npm install -g` (guaranteed EACCES in an image-baked container). Also ships the MIT license + attribution inside both the published npm tarball and the runtime image, and adds a test guarding that every Dockerfile base image stays digest-pinned.
