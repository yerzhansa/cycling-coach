# cycling-coach

## 2026.5.4

### Patch Changes

- 8ce9e94: Fix `/update` and the npm-update notification suggesting a downgrade when the running bot is ahead of npm.

  The version comparison was a string `!==`, so any difference between the running bot's `package.json` version and `registry.npmjs.org/<name>/latest` triggered "Update available" — including cases where the running version was newer (e.g. a Railway deploy from `main` whose CalVer is bumped before the corresponding npm publish has succeeded). On every restart the hosted bot would broadcast `Update available: <new> → <old>` to every chat, and `/update` would `npm install -g …@latest` the older version.

  Replaced with a CalVer-aware comparison (`YYYY.M.D[-N]` parsed into a 4-tuple). Returns true only when latest is strictly newer. Same-day re-release suffix `-N` is treated as newer than the unsuffixed release per the project's CalVer convention (inverts standard semver, which is why we don't use the `semver` package here).

## 2026.5.3

### Patch Changes

- 814dbfb: Fix dates near local midnight in any non-UTC timezone (closes #50).

  The system prompt now carries the IANA timezone name (cache-stable) and a fresh `Current time:` line is appended to each user message. Five "today" call-sites — system prompt, daily-notes filename, intervals_delete_workout past-workout guard, race countdown, daily session-reset hour — now share one resolved athlete TZ instead of computing UTC independently. Resolution chain: `COACH_TZ` env > `session.timezone` (config.yaml) > host TZ (warning) > `"UTC"` (loud warning).

## 2026.5.1

### Minor Changes

- 25fb017: First release after the Core/Sport seam refactor (issue #47). cycling-coach is now bundled via tsup — `@enduragent/core` and `@enduragent/sport-cycling` are inlined into the binary's `dist/index.js` rather than being declared as runtime dependencies. End users continue to install a single npm package; the workspace split is invisible to them. Stub binaries (`running-coach`, `duathlon-coach`) and library packages (`@enduragent/*`) are private and not published — they will be published when the first external consumer needs them. See ADR-0010.
