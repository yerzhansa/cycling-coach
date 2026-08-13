---
"@enduragent/desktop": patch
---

User-facing: Settings → Conversation & time now has a visible Timezone source control with two choices: follow this computer, or use a fixed timezone. Following adopts this computer's timezone every time Enduragent starts, so a machine that moves zones no longer coaches on the old one. Fixed keeps your timezone exactly as you set it. An install from before this change is asked once which to use, and your answer is saved as the setting. COACH_TZ still owns the timezone when it is set, and the control says so instead of pretending to be editable.
