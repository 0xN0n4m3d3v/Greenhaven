# Cartridge Steward (spec 48)

Pre-tool synchronous validator on `create_entity` and `create_quest`.
Deterministic gatekeeper, no LLM call. It rejects spawns that fail
script-mismatch, near-certain duplicate, required-field absence, or world-fact
checks for dynamic hidden/private content. It returns structured
`{ok: false, reason, suggestion}` so the broker can retry with corrected args.

## Goal

Cheap, fast, predictable cartridge hygiene. The Steward catches four failure
modes that the broker drifts into:

1. **Script mismatch.** Conversation is dominantly Cyrillic but generated prose
   fields are dominantly Latin, or the reverse.
2. **Near-certain duplicate** (similarity >= 0.92). Same-kind entity already
   exists with effectively the same name, so the broker should reuse it.
3. **Required-field absence.** Missing `display_name`; missing `summary` on
   `kind=location/scene`. `goal_text` on `create_quest` is optional after spec
   64; the tool derives a deterministic fallback and the Steward validates it
   only when present.
4. **World-fact support.** Dynamic locations require
   `profile.topology_parent_id`. Hidden/private locations also require
   `profile.owner_entity_id` and `profile.access_reason`; if the parent
   location has a different owner, the parent owner must appear as
   `access_authorizer_entity_id`/`access_grantor_entity_id`. Hidden items
   require a holder/home and provenance.

Ambiguous duplicates (0.7..0.92) and tone mismatches pass through here and are
caught async by [Catalogue Scout](catalogue-scout.md). The Steward stays cheap
and synchronous; Scout is the LLM-backed nuance layer.

## Mode

Pre-tool validator. `registerPreToolValidator('create_entity', ...)` and
`registerPreToolValidator('create_quest', ...)` are registered from
[packages/web-server/src/agents/cartridgeSteward.ts](../../packages/web-server/src/agents/cartridgeSteward.ts).

Telemetry rows use `role='agent:cartridge_steward'` for cost/activity audit.

## Output schema

The validator returns one of:

```ts
// pass
{ ok: true }

// reject
{
  ok: false,
  reason: string,
  suggestion?: {
    code?: 'script_mismatch' | 'near_duplicate' | 'required_field_missing' | 'world_fact_guard',
    suggested_display_name?: string,
    existing_entity_id?: number,
    existing_entity_name?: string,
    field?: string,
    profile?: Record<string, unknown>,
  }
}
```

The broker reads `rejected: true` from `dispatch`'s ToolResult and the
`suggestion` payload, then retries with corrected args.

## Where It's Wired

- Validators: [packages/web-server/src/agents/cartridgeSteward.ts](../../packages/web-server/src/agents/cartridgeSteward.ts).
- Registration: [packages/web-server/src/tools/index.ts](../../packages/web-server/src/tools/index.ts).
- Shared world-fact checks: [packages/web-server/src/worldFactGuard.ts](../../packages/web-server/src/worldFactGuard.ts).
- Shared duplicate scoring: [packages/web-server/src/agents/catalogueScout.ts](../../packages/web-server/src/agents/catalogueScout.ts).

## Failure

- DB query failure in script detection, similarity probe, or world-fact lookup
  is fail-open at the pre-tool validator boundary so a broken validator does not
  hang the turn.
- Adventure blueprint validation uses the same world-fact guard before queue
  rows become ready, so unsupported generated hooks are rejected before accept.
- Telemetry write failure logs a warning and does not change the verdict.

## Sources

- [packages/web-server/src/agents/cartridgeSteward.ts](../../packages/web-server/src/agents/cartridgeSteward.ts)
- [packages/web-server/src/worldFactGuard.ts](../../packages/web-server/src/worldFactGuard.ts)
- [packages/web-server/src/agents/catalogueScout.ts](../../packages/web-server/src/agents/catalogueScout.ts)
- [packages/web-server/plans/execution-roadmap/specs/48-cartridge-steward.md](../../packages/web-server/plans/execution-roadmap/specs/48-cartridge-steward.md)
