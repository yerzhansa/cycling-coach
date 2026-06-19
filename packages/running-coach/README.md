# running-coach

AI running coaching agent — critical-speed-anchored pace zones, BYOK + intervals.icu + Telegram.

> **Status: wired, not yet published.** The binary runs from the workspace today; the public `npm install -g running-coach` install lands when the package flips public.

Built on the same Core agent as [`cycling-coach`](../cycling-coach): bring your own LLM API key (Anthropic / OpenAI / Google) or sign in with a ChatGPT subscription, connect [intervals.icu](https://intervals.icu) for real run data, chat via Telegram or CLI.

## What it does today

- Calculates six critical-speed-anchored running pace zones via the `calculate_zones` tool.
- Composes Core's memory and intervals.icu tools with the running soul and skills.

## Run it (workspace dev)

Requires [Node.js](https://nodejs.org/) 22+.

```bash
pnpm --filter running-coach build
node packages/running-coach/dist/index.js setup
node packages/running-coach/dist/index.js
```

## License

MIT
