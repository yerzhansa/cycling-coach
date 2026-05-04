---
"cycling-coach": patch
---

Fix `/update` and the npm-update notification suggesting a downgrade when the running bot is ahead of npm.

The version comparison was a string `!==`, so any difference between the running bot's `package.json` version and `registry.npmjs.org/<name>/latest` triggered "Update available" — including cases where the running version was newer (e.g. a Railway deploy from `main` whose CalVer is bumped before the corresponding npm publish has succeeded). On every restart the hosted bot would broadcast `Update available: <new> → <old>` to every chat, and `/update` would `npm install -g …@latest` the older version.

Replaced with a CalVer-aware comparison (`YYYY.M.D[-N]` parsed into a 4-tuple). Returns true only when latest is strictly newer. Same-day re-release suffix `-N` is treated as newer than the unsuffixed release per the project's CalVer convention (inverts standard semver, which is why we don't use the `semver` package here).
