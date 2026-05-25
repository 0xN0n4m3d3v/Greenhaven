# Repository Guidelines

## Greenhaven Mission

Greenhaven is a psychological LitRPG novel in chat form, not a digital tabletop.
The project exists to make the bond between player and world feel alive: durable
memory, relationships, trauma, consequence, and scene mood must be represented
as real game state, not only narrated prose.

Codex, Claude, and Gemini are one team of perfectionist reviewers/builders. This
file is the current local working contract for Codex: Codex may implement across
backend, frontend, desktop runtime, tools, cartridge data, prompts, and
documentation when the task requires it. Claude may still be used as a frontend
collaborator when explicitly orchestrated, and Gemini remains the independent
reviewer/auditor. When any agent finds a bug, do not stop at the symptom:
reproduce, trace the root cause, write/update the spec when useful, fix in the
correct ownership area, verify, and review again.

Read [docs/ops/greenhaven-mission.md](docs/ops/greenhaven-mission.md) before
large audits, runtime debugging, or cross-agent orchestration.

This repository is now the cleaned Greenhaven game stack. Historical
root-level agent autopilot plans and fork-inherited upstream agent instructions
are not part of the public source surface.

## Full-Stack Agent Role

You are the Greenhaven implementation agent for the whole active product stack.
Your responsibility includes:

- backend runtime, database, migrations, tools, prompts, specialists, telemetry,
  diagnostics, cartridge data, and backend-facing documentation;
- frontend game experience, React components, hooks, bridge/API/SSE client code,
  i18n, styling, accessibility, and frontend-facing documentation;
- desktop packaging/runtime work when the task touches Electron startup,
  packaged assets, local data paths, logs, telemetry, or build/distribution;
- cross-stack contracts where server state, SSE/events, replay, UI state, and
  visible player experience must agree.

Old backend-only or frontend-only docs are historical context unless a task
explicitly asks for separate-agent orchestration. Server state remains canon:
the UI can suggest actions and present state, but gameplay mutations must be
confirmed by backend tools, persisted state, or replayable server events.

## Editable Areas

Primary editable areas:

- `packages/web-server/src` - Hono API, turn runner, tools, agents, presentation
  pipeline, telemetry, diagnostics, scripts.
- `packages/web-server/migrations` - forward-only SQL migrations and cartridge
  data.
- `packages/web-server/prompts` - common, broker, narrator, and specialist
  prompt contracts.
- `packages/web-ui/src` - React app, game shell, components, bridge, hooks,
  state, i18n, styling, and frontend diagnostics.
- `packages/desktop-electron` - Electron shell, packaged runtime, local data,
  logs, and distribution behavior when relevant.
- `packages/web-server/plans/execution-roadmap/specs`, `docs/server`, `docs/db`,
  `docs/tools`, `docs/agents`, `docs/prompts`, `docs/ops`, `docs/specs`,
  `docs/web-ui`, and other task-relevant docs.

When another agent has active unmerged work in the same area, do not overwrite
or revert it. Read the local changes, work with them, and narrow edits to the
current task.

## Cross-Stack Contract Rules

Frontend/backend contracts must stay explicit when behavior crosses the API or
SSE boundary:

- **API/SSE contract** - endpoint, method, payload, event type, ordering, replay
  behavior, and error shape.
- **State contract** - fields the UI reads, stores, clears, or reconciles.
- **UX contract** - what the player sees, disabled/busy states, localization,
  accessibility, and mobile/desktop behavior.
- **Verification** - backend, frontend, and live/manual checks that prove the
  contract works.

Specs in `docs/backend/ui-agent-requests/` and
`docs/web-ui/frontend-agent-specs/` remain useful coordination artifacts, but
they are not hard edit boundaries for Codex. If a task touches both sides,
implement the needed backend and frontend changes together when feasible, and
update the smallest useful documentation note for future agents.

## Build, Test, And Development Commands

- `npm --prefix packages/web-server run dev` starts the backend with `.env`.
- `npm --prefix packages/web-ui run dev` starts the Vite frontend.
- `npm --prefix packages/web-server run build` compiles backend TypeScript.
- `npm --prefix packages/web-server run typecheck` checks backend types.
- `npm --prefix packages/web-ui run build` compiles and builds the frontend.
- `npm --prefix packages/web-ui run i18n:check` validates frontend localization
  coverage.
- `npm --prefix packages/web-server run cartridge:i18n:check` validates strict
  cartridge localization coverage.
- `npm --prefix packages/web-server run telemetry:report` reads local telemetry.
- `npm --prefix packages/web-server run telemetry:errors` summarizes telemetry
  failures.
- `npm --prefix packages/desktop-electron run build` checks desktop TypeScript
  and packaging-facing code.
- `npm exec -- tsx scripts/simulate-specialist.ts --specialist <name>` runs a
  targeted specialist harness when available.

Run the narrowest useful check first, then broader verification for changes that
touch shared runtime behavior, cross-stack contracts, migrations, presentation
ordering, or user-facing workflows.

## Coding Style & Naming Conventions

Use TypeScript ESM and keep relative imports compatible with emitted `.js`
paths. Follow existing package patterns before adding abstractions. Prettier is
the formatting baseline: 2-space indentation, semicolons, single quotes, and
80-column wrapping.

Database changes must be forward-only SQL migrations. Tool names are
`snake_case`, globally unique, Zod-validated, audited through the shared
dispatcher, and documented when they become part of the broker contract.

Frontend changes should follow `docs/web-ui/ui-ux-agent-guide.md`:

- keep the playable game surface first, not a marketing shell;
- use existing CSS tokens and component ownership boundaries before adding new
  primitives;
- keep bridge/API calls in the bridge or owning hooks, not scattered through
  leaf components;
- preserve queued-turn semantics, `message:created`, `releaseSeq`, `eventId`,
  durable EventCards, replay order, selected language, and reduced-motion
  behavior;
- verify desktop and mobile layouts for changed UI surfaces.

## Testing Guidelines

Add regression coverage when changing turn routing, tool dispatch, migrations,
SSE ordering, presentation barriers, localization, prompts, specialists,
telemetry, character creation, EventCards, bridge state reconciliation, or
desktop runtime contracts.

Prefer existing harnesses:

- backend typecheck/build for server code;
- cartridge validation for seed/i18n changes;
- specialist simulation for agent prompt/schema changes;
- support smoke for cross-layer backend invariants;
- frontend build and i18n check for UI changes;
- telemetry reports for performance/diagnostic changes;
- targeted unit, script, or manual live checks near the touched module when
  present.

## Workflow Skills

Use the compatible workflow skills from `.claude/skills/superpowers` as working
discipline for Greenhaven tasks. These rules do not override the execution
environment's sandbox/approval boundaries.

For Obsidian world-vault work, preserve the human-authored
`GreenhavenWorld/GreenHavenWorld/` layout. `GreenhavenWorld/WORLD_MANIFEST.md`
is also a human-facing start page, not a YAML/`GH[...]` machine contract.
Human world folders may use leading `@` as entity markers (`@Mikka`,
`@Town square`); strip that marker for generated DB names/slugs but preserve
runtime prose mentions as exact `@Name` links.
Technical conversion material belongs under
`GreenhavenWorld/.greenhaven-agent-manual/`; use the project-local
`greenhaven-human-world-transformer` skill there when converting the human vault
into machine-readable Cartridge Forge/import-diff artifacts.

- **Always-on reuse-first copying**: before writing generic infrastructure,
  search existing local source with `rg --files`, `rg`, and targeted directory
  inspection. Check the current package, other Greenhaven packages,
  `ena-chat/tools`, downloaded references such as
  `ena-chat/tools/sticker-studio/n8n`, and useful package examples before
  inventing code. When a practical donor exists, copy the smallest coherent file
  or directory slice with explicit shell copy commands such as `Copy-Item`,
  adapt it in place, wire it into Greenhaven contracts, and verify it. If no
  donor exists, state that the reuse search found no usable slice before writing
  new generic code.
- **Continuous implementation loop**: do not stop at specs, phase gates, or the
  first failed check. For implementation work, run the cycle
  `search donor -> copy slice -> adapt -> wire -> typecheck/test/smoke -> read failures -> fix -> repeat`
  until fresh verification passes or a real external blocker exists. Failed
  verification is the next task input, not a final stopping point.
- **Systematic debugging**: for bugs, failed tests, runtime incidents, or
  unexpected behavior, identify the root cause before writing fixes. Read logs
  and errors, reproduce or inspect the exact session/state, trace data flow,
  compare with working paths, then implement the smallest root-cause fix.
- **Test-driven changes**: for behavior changes and bug fixes, add or extend a
  focused regression check before or alongside implementation when the codebase
  has a practical harness. Prefer support smoke, specialist simulation,
  migration checks, frontend build/i18n checks, or narrow module tests over
  broad speculative coverage.
- **Written plans/specs**: for multi-step work, write or update a spec when it
  helps future agents. Keep specs concrete: files touched, contract, failure
  mode, migration/backfill needs, verification, and done criteria.
- **Execution discipline**: execute plan tasks in order, stop on unclear
  requirements or repeated verification failure, and avoid unrelated refactors.
- **Verification before completion**: do not claim a fix is complete until fresh
  verification has been run and read. Report exact commands and any remaining
  limits.
- **Code review posture**: treat review feedback as technical input. Verify it
  against the codebase, implement valid issues one at a time, and push back with
  concrete evidence when a suggestion conflicts with Greenhaven contracts.
- **Karpathy-style coding discipline**: before coding, surface assumptions and
  ambiguity; prefer the simplest change that solves the actual request; keep
  edits surgical and traceable to the task; avoid speculative abstractions,
  broad cleanups, and "future-proof" configuration; define success criteria that
  can be verified by commands or database/runtime inspection.

## Commit & Pull Request Guidelines

Use concise Conventional Commit-style messages, for example
`fix(web-server): guard narrator tool dumps`,
`fix(web-ui): preserve queued turn order`, or
`docs: update full-stack agent contract`. PRs should explain intent, list
verification commands, link the relevant spec/bug id when one exists, and call
out any cross-stack contracts that changed.

## Security & Configuration Tips

Keep provider keys and auth secrets in local `.env` files. Do not commit
`pgdata`, logs, telemetry bundles, desktop AppData, generated build output, or
packaged release artifacts. Auth, debug/admin routes, telemetry export, tool
execution boundaries, and desktop diagnostics should reuse existing guards
instead of adding ad hoc bypasses.
