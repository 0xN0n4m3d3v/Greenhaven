# Surfaces & combos

DOS:OS-style environmental layer. The location's `surfaces[]` runtime field lists what's on the floor / in the air right now. Surfaces have lifetimes, combo-fire on contact, and impose conditions on combatants standing in them. Spec 33; migration [packages/web-server/migrations/0034_surfaces_and_inspiration.sql](../../packages/web-server/migrations/0034_surfaces_and_inspiration.sql).

Full ruleset: [packages/web-server/prompts/greenhaven.broker.md](../../packages/web-server/prompts/greenhaven.broker.md). Tool: [packages/web-server/src/tools/surfaces.ts](../../packages/web-server/src/tools/surfaces.ts).

## Surface types

Spawn via `apply_surface(location, type, severity, area, source, lifetime_turns?)`.
For AI/batch calls, `source` is mandatory. It must be an exact present
item/display name, an existing active surface type, current location evidence,
or a successful same-turn tool result. Unsupported ambience stays prose and does
not become a canon surface.

| Kind | Texture |
|---|---|
| `fire` | Open flame. Damages standing combatants. Combos with oil, smoke, water. |
| `oil` | Slick floor coating. Disadvantage on next dice_check (slip). Combos catastrophically with fire. |
| `water` | Shallow pool. Combos with electricity (shocked) and ice (slick). |
| `ice` | Frozen surface. Slick — same disadvantage as oil. Melts via fire. |
| `poison` | Toxic vapour or pool. Damages over time + applies poisoned condition. |
| `blood` | From a wound. Texture only, no mechanic — but olfactory signal NPCs notice. |
| `electricity` | Sparking, exposed cable, magic. Combos with water (shocked). |
| `smoke` | Vision blocker. Disadvantage on perception/ranged in this turn. Combos with fire (suffocating). |
| `web` | Sticky terrain. Restrains; counts as restrained condition. |

`severity` ∈ 1..3 scales the magnitude (1 = light splash, 3 = saturated). `area` (optional) describes scope ("the doorway", "the front half of the cart"). `lifetime_turns` defaults per kind (water 5, fire 3, oil 8, …); decay handled by `decrementSurfaces` ([packages/web-server/src/transitionEngine.ts](../../packages/web-server/src/transitionEngine.ts)) which ticks each turn.

Use surfaces freely — even outside combat. Spilled lamp oil, blood from a wound, fog rolling in. Texture, not just damage.

## Combos

Combos auto-fire when surfaces overlap. `apply_surface(type=..., source=...)` on a location with an existing surface checks for the registered combo:

| Surface A | Surface B | Combo | Effect |
|---|---|---|---|
| oil | fire | `explosion` | Heavy damage to combatants in area; smoke replaces oil. |
| water | electricity | `shocked` | Stuns combatants in water. |
| water | ice | `slick` | Compounds slip disadvantage. |
| ice | fire | `melt` | Ice → water. Fire severity drops by 1. |
| smoke | fire | `suffocating` | Smoke severity bumps; combatants take negotiation/breath check. |

When a combo fires, `apply_surface` returns `{ok: true, combo_fired: 'explosion', narrate_hint: '...', side_effects: [{tool: 'damage', args: {...}}, ...]}`. Broker reads, calls each side-effect tool (`damage`, `apply_condition`, etc.), then narrates the combo per the hint.

Implementation: combo registry is in [packages/web-server/src/tools/surfaces.ts](../../packages/web-server/src/tools/surfaces.ts). To add a combo, register the (a, b) pair → side_effects array. Idempotent on (a, b) and (b, a).

## Standing in a surface

At the start of any beat where a combatant is in a surface, the broker MUST call the appropriate state tool. From the prompt:

| Surface | At start of beat (combatant standing in it) |
|---|---|
| fire | apply `bleeding(burning)` condition; 4-8 damage/turn |
| shocked water | save vs DC 12; on fail, `stunned` for 1 turn |
| poison | apply `poisoned`; 2-4 damage/turn |
| oil | next `dice_check` has `disadvantage: true` (slip) |
| ice | same as oil (slip) |
| web | apply `restrained` condition; until break-free check |

The narrator describes the surface concretely — "the oil licks at your boots", "the water hums with the broken cable", "the corpse-smoke stings the eyes". Don't just call the tool; describe the world.

The frontend renders active surfaces as a chip strip in `SceneSurfaceStrip.tsx` ([packages/web-ui/src/components/scene/SceneSurfaceStrip.tsx](../../packages/web-ui/src/components/scene/SceneSurfaceStrip.tsx)) with severity-tinted colour and tooltip mechanic.

## Sources

- [packages/web-server/prompts/greenhaven.broker.md](../../packages/web-server/prompts/greenhaven.broker.md) — broker surfaces ruleset
- [packages/web-server/src/tools/surfaces.ts](../../packages/web-server/src/tools/surfaces.ts) — `apply_surface` tool, combo registry
- [packages/web-server/src/transitionEngine.ts](../../packages/web-server/src/transitionEngine.ts) — `decrementSurfaces` lifetime decay
- [packages/web-server/migrations/0034_surfaces_and_inspiration.sql](../../packages/web-server/migrations/0034_surfaces_and_inspiration.sql) — schema
