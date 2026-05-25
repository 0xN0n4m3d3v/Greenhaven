# Catalogue Scout (spec 42)

Async post-turn observer. Scans the just-finished turn's `toolHistory` for
`create_entity` / `create_quest` calls, fuzzy-matches each new entity against
existing entities of the same kind, and emits an `entity:duplicate_warning` SSE
for the frontend to render an informational EventCard.

## Goal

Stop the broker silently spawning duplicate NPCs / locations / scenes / items.
The "Reuse before spawn" rule is in
[packages/web-server/prompts/greenhaven.md](../../packages/web-server/prompts/greenhaven.md),
but the broker still spawns "Mikka the Goblin" when the canonical entity is
"Mikka Quickgrin"; "Inn Common Room" when "Quiet Lantern Inn → Common Hall"
already exists. The Scout is the post-hoc audit.

Hybrid scoring approach to keep cost low
([packages/web-server/src/agents/catalogueScout.ts:14-22](../../packages/web-server/src/agents/catalogueScout.ts#L14-L22)):

| Score band    | Action                                                          |
| ------------- | --------------------------------------------------------------- |
| `0.0 .. 0.7`  | Unique. No action. No LLM call.                                 |
| `0.7 .. 0.89` | Ambiguous. Defer to LLM verdict (`runSpecialist`).              |
| `0.9 .. 1.0`  | Near-certain duplicate. Emit warning directly without LLM call. |

The score is a 50/50 blend of normalised Levenshtein and Jaccard token overlap
([packages/web-server/src/agents/catalogueScout.ts:217-220](../../packages/web-server/src/agents/catalogueScout.ts#L217-L220)).
Top 5 candidates per kind are pulled.

MVP is **advisory-only** — never mutates DB. Auto-merge with FK updates is a
future follow-up.

## Mode

`async` post-turn pipeline hook. Owned by
[packages/web-server/src/postTurnPipeline.ts](../../packages/web-server/src/postTurnPipeline.ts)
as `catalogueScoutHook`.

## Output schema

LLM only fires for the ambiguous band. Schema at
[packages/web-server/src/agents/catalogueScout.ts:129-134](../../packages/web-server/src/agents/catalogueScout.ts#L129-L134):

```ts
{
  verdict: 'merge' | 'rename' | 'keep_both' | 'unique',
  best_match_id: number | null,
  reasoning: string,
  recommended_action: 'use_existing' | 'rename' | 'keep_both',
}
```

The hook then composes an `entity:duplicate_warning` SSE payload:

```ts
{
  new_entity_id, new_name, kind,
  verdict, best_match_id, best_match_name, score,
  reason, candidates: [{id, display_name, score}, ...]
}
```

## Where it's wired

- Hook export: `catalogueScoutHook` at
  [packages/web-server/src/agents/catalogueScout.ts:39-125](../../packages/web-server/src/agents/catalogueScout.ts#L39-L125).
- Imported into the post-turn pipeline at
  [packages/web-server/src/postTurnPipeline.ts](../../packages/web-server/src/postTurnPipeline.ts).
- `extractNewEntities`
  ([packages/web-server/src/agents/catalogueScout.ts](../../packages/web-server/src/agents/catalogueScout.ts))
  pulls entities created by `create_entity` (`result.id`) and `create_quest`
  (`result.spawned` name-to-id map). Legacy `result.spawned_entity_ids` audit
  rows are still tolerated, and batch child entries work through the same path
  after spec 67.
- `findFuzzyCandidates(kind, name, excludeId, limit)` queries `entities`
  filtered by kind, scores each, returns top N with score ≥ 0.5.
- Emits `entity:duplicate_warning` SSE; frontend's EventCard renders the warning
  with a "use existing" affordance.
- Debug runner: `POST /api/debug/run-catalogue-scout` at
  [packages/web-server/src/index.ts:831](../../packages/web-server/src/index.ts#L831).

## Failure & fail-open

- `runSpecialist` returns null on the LLM band → no warning emitted (Scout is
  conservative on the ambiguous band).
- Per-entity error → log warning + continue with next entity. One bad fuzzy
  match can't stop the whole post-turn run.
- Empty `toolHistory` or no `create_entity`/`create_quest` calls → early return
  at
  [packages/web-server/src/agents/catalogueScout.ts:43](../../packages/web-server/src/agents/catalogueScout.ts#L43);
  zero specialist call.
- Timeout 6000ms — Scout fires after `turn.end`, latency is amortised over the
  next preamble.

The fail-open path means duplicates may still slip through; the worst case is
two NPCs with similar names and the player has to disambiguate via `@`-mention.

## Prompt

Source:
[packages/web-server/src/agents/catalogueScoutPrompt.ts](../../packages/web-server/src/agents/catalogueScoutPrompt.ts).

System covers:

- The four verdicts (merge / rename / keep_both / unique).
- Kind-specific guidance (locations are tighter — same building rarely needs two
  entities; NPCs more permissive — different goblins exist).
- Cartridge canon: when a candidate's `summary` describes a uniquely-defined
  character/place, push toward `merge`.
- Multilingual: candidate `display_name`s are aliased — the model should compare
  semantic meaning, not just byte equality.

Temperature 0.2 — duplicate detection wants determinism. `maxOutputTokens: 400`
— verdict + short reasoning, no padding.

Output is JSON only. The 4-verdict enum forces a discrete decision.

## Sources

- [packages/web-server/src/agents/catalogueScout.ts](../../packages/web-server/src/agents/catalogueScout.ts)
  — hook, hybrid scoring, fuzzy match
- [packages/web-server/src/agents/catalogueScoutPrompt.ts](../../packages/web-server/src/agents/catalogueScoutPrompt.ts)
  — system prompt + user builder
- [packages/web-server/plans/execution-roadmap/specs/42-catalogue-scout.md](../../packages/web-server/plans/execution-roadmap/specs/42-catalogue-scout.md)
  — original spec
