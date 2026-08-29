# Privacy

The full policy, covering both the website and the software, is at
<https://enduragent.icu/privacy.html>. This page covers the one background request the self-hosted
bot makes.

Your training data stays on your machine. There is no Enduragent account, no server of ours that
holds your training history, and no analytics in the product. Your prompt and the training numbers
in it go to the model provider you chose; your intervals.icu key goes to intervals.icu.

Access to a self-hosted Telegram bot is limited to an allowlist you control — see
[telegram.md](./telegram.md).

### Update checks & usage counting

As part of its background version-check behavior, Cycling Coach can make an HTTPS request to `ping.enduragent.icu`. That endpoint returns the latest published version (the same answer `registry.npmjs.org` gives) and records an anonymous usage count so the project can see roughly how many instances are running across install channels. The count contains no personal information.

The bot attempts telemetry on Telegram-mode startup and again every 24 hours, but a timestamp in the installation data directory limits it to at most once in any 24-hour period even across restarts. The timestamp is saved before the request, so a crash or an unreachable endpoint cannot retry telemetry for 24 hours. If the endpoint is unavailable or rate-limited, the bot silently falls back to `registry.npmjs.org` for the version result.

Set `CYCLING_COACH_NO_UPDATE_CHECK=1` to disable the automatic background checks (both the startup check and the daily re-check). The operator-initiated `/update` and `/whatsnew` commands never initiate telemetry; their version lookups use `registry.npmjs.org` and reuse a recent or already-running result. `/whatsnew` also reaches the GitHub Releases API for release notes. In managed container deploys, `/update` does not run npm; image hosts update by redeploying the container image.

Desktop does not fetch release notes in the background. Choosing **What’s new** explicitly contacts
`registry.npmjs.org` for the latest published version and the GitHub Releases API for that exact
version’s athlete-facing notes. Those requests send no installation identifier, credential,
configuration, or athlete data.
