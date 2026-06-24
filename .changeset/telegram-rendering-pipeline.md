---
"@enduragent/core": patch
---

User-facing: Workout prescriptions and code blocks now render exactly as written, links are clickable, and formatting errors fall back to clean readable text.

The Telegram markdown→HTML converter now extracts fenced code blocks from the raw source before escaping (mirroring the table path), so a fenced workout like `- 4x8min @ 105%` survives byte-for-byte instead of having its bullets, headers, and italics mangled inside the `<pre>`. The italic regex is tightened so spaced asterisks in interval math (`do 3 * 8 reps`) keep their literal `*`. An http/https-only `[text](url)` rule renders clickable links with attribute-escaped hrefs and no double-escaped `&` in multi-param query strings. The long-message hard split no longer bisects an HTML tag, entity, or surrogate pair. When Telegram rejects a chunk, the fallback now delivers human-readable source text rather than resending raw tag soup. Finally, the `/snapshot` debug dump rides the same HTML path, dropping the lone legacy Markdown parse mode.
