# Documentation Refresh Log

This page is the working loop for keeping Greenhaven documentation aligned with
runtime behavior. It is intentionally operational: future agents should update
this page when they audit docs, find stale contracts, or finish another refresh
cycle.

## Refresh Method

Use this loop:

1. Inventory the docs with `rg --files docs` and targeted `rg` searches for old
   contracts.
2. Compare docs against source code, migrations, prompts, and current specs.
3. Update the smallest owning page first: overview, architecture, server, UI
   reference, system design, or ops.
4. Record what changed here, including known stale areas that remain.
5. Run a narrow verification pass: at minimum link/search checks and relevant
   type/build checks if code comments or examples changed.

Do not turn historical specs or bug logs into current contracts. Specs are
process records. The current contract lives in active source files plus the
reader-facing docs under `docs/`.

## Cycle 2026-05-14

### Scope

The pass updated the current entry layer after dialogue/adventure/living-world
changes:

- root docs navigation and current status;
- architecture and runtime stack;
- server turn pipeline and migration overview;
- UI architecture and dialogue data flow;
- NPC component reference around legacy `PartnerSwitch`;
- EventCard, bridge, SSE, and API references for adventure hook menu actions;
- companion follow docs and movement tool comments;
- adventure queue accept/ignore consequences;
- support-smoke command and caveats;
- specs index through Spec 145.

### Current Runtime Facts Captured

- Active migrations run through `0101_mikka_portrait_set.sql`.
- Specs now extend through Spec 145. Spec 112 remains a long-running
  anti-god-layer cleanup umbrella, while later specs are concrete slices.
- Manual "end dialogue" UI is gone. Dialogue focus is switched or released by
  server-side player intent: another NPC address, travel/location action,
  non-dialogue action, or farewell.
- Active companion focus can persist across movement. Companions are rendered in
  `## DIALOGUE PARTICIPANTS` and may participate in shared chats with separate
  authored bubbles.
- Adventure card accept/ignore actions submit ordinary turns with
  `adventure.accept:<queueId>` / `adventure.ignore:<queueId>`, so the NPC/world
  can answer immediately.
- Ignoring a visible adventure hook cancels that row, records baseline refusal
  evidence/consequence, and must not materialize the refused quest/spawns.
- `player:moved` refreshes location/nearby/map state only. Dialogue focus comes
  from `dialogue:participants_updated` / `dialogue:partner_switched`.
- Companion movement is roster-presence plus `npc:moved_with_player` card
  emission and context overrides. The common path does not recursively call
  `move_player` for every companion.

### Known Remaining Stale Areas

- `docs/bugs/code-audit-log.md` contains historical statements that are no
  longer true, such as travel clearing dialogue immediately. Treat it as a log,
  not current contract.
- `docs/superpowers/plans/*` are historical UI restoration plans and can mention
  removed props such as `onEndDialogue`.
- UI reference proposal pages may still mention older component layouts. Treat
  files under `docs/ui-reference/proposals/` as proposals, not current UI.
- Some support-smoke history says the suite was green at older checkpoints; keep
  those entries as historical facts, but check `docs/ops/support-smoke.md` for
  current interpretation.
- `docs/server/npc-memory.md` has an explicit risk list about memory/search/save
  restore gaps. Those entries are current risk claims until verified against
  source, not stale docs to delete.

## Search Checklist

Useful stale-contract searches:

```sh
rg -n "EndDialogue|onEndDialogue|handleEndDialogue|end dialogue|завершить диалог" docs packages/web-ui/src
rg -n "0072|0101|Latest implemented specs|Spec 112|Spec 145" docs
rg -n "player:moved.*dialogue|dialogue:participants_updated|PartnerSwitch" docs packages/web-ui/src
rg -n "adventure.accept|adventure.ignore|mutates no world state|baseline refusal" docs packages/web-server/src
rg -n "recursive case|recursive per-companion|auto-follow loop|follow_player" docs packages/web-server/src/tools/movement.ts
rg -n "Backend Agent Role|backend only|Do not directly implement UI|Claude owns frontend" docs AGENTS.md
```

## Verification Notes

For this cycle, these fresh checks passed after the documentation and comment/UI
text refresh:

- `npm --prefix packages/web-server run typecheck`
- `npm --prefix packages/web-ui run build`

Earlier checks after the related runtime work also passed:

- `npm --prefix packages/web-server run build`
- `npm --prefix packages/web-ui run i18n:check`

The broad support smoke suite may be red for unrelated guardrail/fixture
failures. When it fails, quote the exact failing checks and whether the check
touches the current documentation/runtime contract.
