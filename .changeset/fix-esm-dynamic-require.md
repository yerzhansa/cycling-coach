---
"cycling-coach": patch
---

User-facing: Fixed a startup crash that stopped the bot from launching on the latest release.

The published binary bundles workspace packages inline, which pulls in transitive CommonJS dependencies whose `require()` of Node builtins hit esbuild's ESM dynamic-require shim and threw at startup. A `createRequire` banner in the bundle gives that shim a real `require` to delegate to, so the builtins resolve normally.
