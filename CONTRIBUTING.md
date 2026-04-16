# Contributing

## Branch Naming

```
feat/<short-description>   — new feature
fix/<short-description>    — bug fix
chore/<short-description>  — maintenance, deps, config
docs/<short-description>   — documentation only
refactor/<short-description> — code restructuring, no behavior change
```

Use lowercase, kebab-case. Keep it under 50 characters.

Examples: `feat/session-management`, `fix/telegram-html-escape`, `chore/bump-intervals-api`.

## Pull Requests

- **Title**: imperative mood, under 70 characters (e.g., "Add session management and context compaction")
- **Branch**: always branch off `main`, PR back into `main`
- **One concern per PR**: don't mix unrelated features in a single PR
- **Description**: include a Summary (what and why) and a Test Plan

## Commits

- Imperative mood: "Add X", "Fix Y", not "Added X" or "Fixes Y"
- One logical change per commit when practical
