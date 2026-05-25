# Greenhaven Mission And Agent Pact

Greenhaven is not a digital tabletop. It is a psychological LitRPG novel in
chat form: a living world where the normally hidden parts of play are visible,
including character bonds, accumulated trauma, memory, and the emotional state
of a scene. The goal is a game that feels alive from the first second and keeps
the player connected to the world, not a fantasy UI wrapped around a generic
chatbot.

## Product North Star

- The player-world bond is the core feature.
- Memory, relationships, trauma, mood, and consequences must be represented as
  durable game state, not only prose.
- Scene state is emotional and narrative, not just map position.
- UI/UX should make the world legible, pleasant, and marketable without turning
  the game into a board-game dashboard.
- Runtime behavior matters more than documents that claim the behavior exists.

## Team Pact

Codex, Claude, and Gemini are one engineering team, not competitors.

- **Codex** is the default implementation agent in this local workspace and may
  work across backend, frontend, desktop runtime, prompts, cartridge data,
  diagnostics, and documentation when the task requires a cross-stack fix.
  Backend state remains the source of gameplay truth.
- **Claude** may still be used as a frontend UI/UX/GUI collaborator when an
  explicit orchestration workflow is requested. Frontend handoff specs remain
  useful coordination artifacts, not hard edit boundaries for local Codex work.
- **Gemini** is the independent hacker/perfectionist reviewer. Gemini audits the
  whole project read-only, finds defects and design risks, and proposes
  investigation paths. Gemini does not fix code in the normal workflow.

## Audit Philosophy

Every major change should be tested like an adversarial player will use it:
accept quests, interrupt turns, ask NPCs about active obligations, travel,
trigger stale events, replay sessions, refresh the UI, switch languages, and
inspect AppData/runtime logs. A bug found by any agent becomes controller work:
reproduce, trace root cause, write or update a spec, implement the smallest
valid fix in the correct ownership area, verify, and ask Gemini for another
review pass.

Do not create giant magical classes, prompt dumps, or vague "future-proof"
systems. Fix actual root causes with traceable state contracts and regression
checks.

## Full-Audit Scope

Gemini audits all Greenhaven bricks:

- repository documentation and specs;
- server runtime, turn runner, tools, prompts, specialists, migrations, and
  telemetry;
- web UI state flow, SSE/event replay, event cards, turn queue, localization,
  and frontend/backend contracts;
- desktop packaging/runtime assumptions;
- AppData session logs, telemetry, and database symptoms supplied by Codex;
- tests, support smoke, build output, and verification gaps.

Gemini uses a thinking model for deep audits, preferably `gemini-2.5-pro`.
Routine smoke review may use `gemini-2.5-flash` when speed or capacity matters.
