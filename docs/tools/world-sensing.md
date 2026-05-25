# World-Sensing Tools

Spec 63 adds four broker-callable read-only tools. They help the model ask for compact world context without mutating state or calling an LLM.

All reads are scoped to `ctx.playerId`. Passing a different `player` argument is rejected. The only write caused by these tools is the normal `tool_invocations` audit row from the shared tool boundary.

## summarize_relationships

Args:

```ts
{target: string, player?: string, limit?: number}
```

Reads strings, memories, recent dialogue, and recent target-related tool events. Returns:

```ts
{
  ok: true,
  target,
  relationship: {
    strings: number,
    string_band: 'hostile'|'wary'|'neutral'|'friendly'|'trusted'|'bonded',
    social_band: 'hostile'|'neutral'|'friendly'|'intimate',
    confidence: 'low'|'medium'|'high'
  },
  evidence: [...],
  unresolved_tensions: string[]
}
```

Use when the broker needs "where do we stand with this NPC?" before choosing tone or risk.

## evaluate_social_standing

Args:

```ts
{target: string, player?: string, limit?: number}
```

Returns a deterministic social band plus evidence. It is a smaller, decision-oriented form of `summarize_relationships`.

## get_recent_history

Args:

```ts
{
  session_id?: string,
  domains?: Array<'tools'|'quests'|'inventory'|'memories'|'chat'>,
  limit?: number
}
```

Returns bounded events from selected domains. Defaults to tools, quests, inventory, and memories. Chat is opt-in because raw chat is noisy.

## predict_consequence

Args:

```ts
{tool_name: string, args?: Record<string, unknown>, session_id?: string, limit?: number}
```

Reads active quest failure predicates and current-stage objectives. It flags likely risks and likely progress for `tool_called` predicates, and returns unsupported predicate shapes instead of inventing.

It also checks obvious state constraints:

- `move_player` to a location that is not the current location or a declared exit.
- `inventory_transfer` from the player with insufficient legacy inventory count.

## Failure Modes

- Unknown targets return `{ok:false, error}`.
- Cross-player inspection through `player` throws and is returned as a tool error.
- Unsupported quest predicates appear in `unsupported_predicates`.
- Low evidence returns `confidence:"low"`.

## Verification

- `npm --prefix packages/web-server run typecheck`
- `npm --prefix packages/web-server run build`
- Smoke fixture in a temporary PGlite DB dispatches all four tools and confirms `predict_consequence` flags a quest failure risk.
- Static check on [worldSensing.ts](../../packages/web-server/src/tools/worldSensing.ts) confirms it only reads gameplay tables; no direct `INSERT`, `UPDATE`, or `DELETE`.

## Sources

- [packages/web-server/src/tools/worldSensing.ts](../../packages/web-server/src/tools/worldSensing.ts)
- [packages/web-server/plans/execution-roadmap/specs/63-read-only-world-sensing-tools.md](../../packages/web-server/plans/execution-roadmap/specs/63-read-only-world-sensing-tools.md)
