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

To check whether a newer version exists, Cycling Coach makes one background HTTPS request to `ping.enduragent.icu`. That endpoint returns the latest published version (the same answer `registry.npmjs.org` gives) and records an anonymous usage count so the project can see roughly how many instances are running across install channels. The count contains no personal information.

The check runs on Telegram-mode startup and again every 24 hours (so a long-running deployment learns about new releases without a restart). The same request powers the "update available" notification and the `/whatsnew` and `/update` commands. In development and test the bot talks to `registry.npmjs.org` directly instead; if the `ping.enduragent.icu` endpoint is ever unreachable, the bot silently falls back to `registry.npmjs.org`, so update checks keep working either way.

Set `CYCLING_COACH_NO_UPDATE_CHECK=1` to disable the automatic background checks (both the startup check and the daily re-check). The operator-initiated `/update` and `/whatsnew` commands still query the endpoint — those are explicit requests, not background checks (and `/whatsnew` also reaches the GitHub Releases API for release notes). In managed container deploys, `/update` does not run npm; image hosts update by redeploying the container image.

Desktop does not fetch release notes in the background. Choosing **What’s new** explicitly contacts
`registry.npmjs.org` for the latest published version and the GitHub Releases API for that exact
version’s athlete-facing notes. Those requests send no installation identifier, credential,
configuration, or athlete data.
