---
name: create-verification-skill
description: Create one project-local Codex verification skill that drives a real application surface, captures observable proof, and preserves the repository's existing test drivers. Use only when explicitly invoked as `$create-verification-skill`.
---

# Create Verification Skill

Create a verification skill for the next agent to use cold during implementation or UI QA. Keep product intent in the repository's existing design authority; the generated skill records only reachability, commands, prerequisites, and observable proof.

## Inspect before asking

Read the repository instructions and inspect the checkout before asking the user questions. Establish:

- The user-facing surface to verify.
- The documented build and launch commands.
- Every existing executor, including Playwright, CDP, Cypress, Vitest, service clients, PTY helpers, or platform-specific harnesses.
- Existing fixtures, scenario manifests, evidence conventions, and privacy checks.
- Isolation controls for ports, profiles, data directories, credentials, and cleanup.
- Existing project-local verification skills and the surfaces they own.

Ask only for decisions that source and repository documentation cannot answer. If an existing verification skill already owns the requested surface, stop and report its path instead of creating a competing inventory.

## Preserve the repository's harnesses

Reuse an existing harness before adding a dependency or protocol. Preserve every existing executor and keep their ownership boundaries: Playwright and CDP may be sibling executors, and neither replaces the other. Do not require every feature to use one driver.

Do not change product behavior to make verification easier. Verification-only helpers may be added only when the repository has no safe existing seam and their ownership is explicit.

## Generate the Codex skill

Create `.agents/skills/verify-<app>/` with:

```text
SKILL.md
agents/openai.yaml
references/features/README.md
references/features/<feature>.md
```

Use valid YAML frontmatter with `name: verify-<app>` and a precise description naming the app, surface, and verification or UI-QA situations that should trigger it. Let the verification skill be implicitly invocable unless the user requires explicit-only use.

Ground these sections in the inspected repository and leave no placeholders:

- **Prepare:** exact build commands and how to identify stale or missing outputs.
- **Launch:** the isolated launch command, readiness signal, owned state, and teardown command.
- **Doctor:** a read-only check that proves the instance is safe and worth driving.
- **Drive:** exact commands and stable selectors for each existing executor.
- **Evidence:** required action, result, accessibility, persistence, log, or screenshot proof and its retained location.
- **Cleanup:** idempotent teardown of only owned processes and scratch state while retaining evidence.

Never drive the operator's normal profile, credentials, production data, or shared instance. Never kill processes by name. Scrub secrets, real identifiers, current-era fixture dates, and temporary private paths from retained evidence.

## Seed one feature map

Create one index and one page per high-level user-facing feature. Derive the map from existing scenario manifests, routes, commands, menus, and tests; do not create a second independent scenario inventory.

Read [`references/feature-map-example/README.md`](references/feature-map-example/README.md) and [`references/feature-map-example/example.md`](references/feature-map-example/example.md) before writing the map. Each feature page must use exactly these H2 headings:

```text
## Sub-features
## How to get to it (user POV)
## Driving it with <harness>
## Gotchas
```

Reference existing scenario or test identifiers, name every supported entry point, state the fixture and executor, provide exact commands, define observable success and side-effect proof, and record concrete platform, authentication, entitlement, or external-state prerequisites.

## Prove one feature

Run the generated instructions end to end for one mapped feature:

1. Prepare and launch an isolated instance.
2. Run doctor before driving.
3. Exercise the real user path.
4. Capture the action and resulting state.
5. Confirm any mutation through a second read-only view.
6. Clean up all owned runtime state.
7. Confirm the evidence still exists and no owned process or listener remains.

Run cleanup after every failed attempt. Report completion only after this proof passes; otherwise report the concrete blocker.
