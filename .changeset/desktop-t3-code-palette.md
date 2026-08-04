---
"cycling-coach": patch
---

User-facing: Added the T3 Code palette to desktop appearance settings, with matching light and dark colors.
User-facing: Refreshed the desktop app's visual design — DM Sans typography, softer surfaces with a subtle paper grain, consistent button and input shapes, and quieter scrollbars.

The desktop renderer now carries a shared design system ported from T3 Code (MIT, attributed in
`NOTICE.md`): geometry, elevation and typography tokens in `theme/tokens.css`, plus a CSS Modules
primitive sheet (`theme/surface.module.css`) that every view composes for cards, controls, fields,
chips and list rows. Filled controls invert to `--ink` rather than an accent hue, so the chrome
stays monochrome across all fifteen palettes.
