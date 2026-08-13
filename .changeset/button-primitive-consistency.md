---
"@enduragent/desktop": patch
---

User-facing: Delete buttons in setup and settings now sit at the same weight as the buttons beside them and differ only in colour, the confirm button in a delete prompt is a filled red so it never reads as the same control as Cancel, and buttons, links and dropdowns across setup and settings show the hand cursor on hover.

Danger is a colour, not a button weight. The renderer now exports exactly two danger constants: `BUTTON_DANGER_QUIET_SM` at the quiet weight (no border, transparent background) for every in-row destructive action, and `BUTTON_DANGER_SOLID_SM` at the solid weight for the confirm button in `InlineConfirmation`, where a fill keeps the destructive action distinguishable from Cancel without relying on colour alone. `surface.module.css` `.dangerous` mirrors the quiet variant so the Reset conversation button matches without migrating that file to Tailwind.
