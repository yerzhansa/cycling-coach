---
"@enduragent/desktop": patch
---

Ship the `en-US` Chromium locale pak in the Windows package. `electronLanguages: [en]` matched nothing under app-builder-lib's inverted prefix filter, so every locale pak was deleted from `win-unpacked/locales/` and Blink null-dereferenced in `Locale::DefaultLocale` the first time a renderer wrote a value into a number input. The Windows package verifier now requires a present, non-empty `locales/en-US.pak` and rejects any other locale entry.
