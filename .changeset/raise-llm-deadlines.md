---
"cycling-coach": patch
---

User-facing: Coach replies now get more time to finish on complex requests before timing out.

Raise the owned model-call deadlines and the per-turn wall-clock so a legitimately-slow reasoning turn is not cut off prematurely: flush/compact 3->5 min, chat 5->10 min, per-turn wall-clock 5->10 min. The chat per-call deadline is clipped by the turn's remaining wall-clock budget, so raising the chat cap is only effective alongside the matching wall-clock raise.
