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

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>
```

**Types:**

| Type | When |
|------|------|
| `feat` | New feature or capability |
| `fix` | Bug fix |
| `chore` | Maintenance, deps, config |
| `docs` | Documentation only |
| `refactor` | Code restructuring, no behavior change |
| `test` | Adding or updating tests |
| `perf` | Performance improvement |
| `ci` | CI/CD changes |
| `style` | Formatting, no logic change |

**Scope** is optional — use the module name when helpful: `core`, `telegram`, `soul`, `config`, `tools`, `memory`.

**Examples:**
```
feat(core): add rate limit retry with backoff
fix(soul): prevent coaching tone drift and emoji-only responses
chore(deps): update intervals-icu-api to 0.1.2
refactor(telegram): extract error formatting helper
test(endurance): add 100-message endurance test
docs(plan): add battle plan for rate limit fix
```

**Rules:**
- Imperative mood: "add X", "fix Y", not "added X" or "fixes Y"
- Lowercase after the colon
- One logical change per commit when practical
