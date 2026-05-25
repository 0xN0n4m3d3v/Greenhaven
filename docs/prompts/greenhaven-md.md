# Prompt System

Greenhaven no longer uses one large broker+narrator prompt as the active runtime
contract. Specs 100 and 112 split prompt ownership into small role-scoped files.

## Active Files

- [packages/web-server/prompts/greenhaven.md](../../packages/web-server/prompts/greenhaven.md)
  - common identity and shared runtime contract.
- [packages/web-server/prompts/greenhaven.narrator.md](../../packages/web-server/prompts/greenhaven.narrator.md)
  - visible prose rules for narrator paths.
- [packages/web-server/prompts/greenhaven.broker.md](../../packages/web-server/prompts/greenhaven.broker.md)
  - compatibility index; it intentionally does not contain the old catch-all
    broker prompt.
- [packages/web-server/prompts/broker/](../../packages/web-server/prompts/broker/)
  - broker fragments assembled by mode.

The loader is
[packages/web-server/src/ai/prompts.ts](../../packages/web-server/src/ai/prompts.ts).

## Common Prompt

`greenhaven.md` is intentionally small. It establishes in-world actor identity,
selected-language behavior, player agency, cartridge tone obedience, and shared
output hygiene. Shared rules belong here only when both broker and narrator need
them.

## Broker Fragments

Broker fragments live under `prompts/broker/` and are selected through
`BROKER_PROMPT_FRAGMENT_MANIFEST`. Base fragments cover language, entity spawn
mentions, voice authoring, grounded action sources, active player identity, turn
context, mandatory tools, movement, companions, ability checks, affordances, and
mention handling.

Mode fragments narrow the active contract:

- `combat`: combat, position/effect, conditions, bargains, trauma, surfaces.
- `intimacy`: intimacy, strings, sex moves, quest mechanics, memory,
  inspiration.
- `dialogue`: dynamic quests, memory, strings, quest mechanics, inspiration.
- `exploration`, `travel`, `rest`: dynamic quests, quest narrative, surfaces,
  inspiration.

## Narrator Prompt

`loadNarratorPrompt()` joins the common prompt with `greenhaven.narrator.md`.
The narrator receives only the executable `narrate` tool. It must render visible
prose, avoid technical/tool syntax, obey author and tone rules, and keep hidden
analysis out of player-facing text. Narrator JSON/tool dumps are quarantined by
the narration stage before `chat_messages`.

## Tool Scope

- Broker: mode-filtered gameplay tools from `toolsForBrokerMode()`.
- Narrator: `narrate` only.
- Scene Painter: `narrate` only.

## Maintenance Rules

- Add new mechanics to the smallest owned broker fragment.
- Do not restore broad `greenhaven.broker.md`.
- Do not duplicate specialist few-shots with stale names or fixed player ids.
- Keep selected-language examples neutral and source-grounded.
- Keep `prompts/greenhaven.md` common.

## Sources

- [packages/web-server/src/ai/prompts.ts](../../packages/web-server/src/ai/prompts.ts)
- [packages/web-server/src/ai/toolsets.ts](../../packages/web-server/src/ai/toolsets.ts)
- [packages/web-server/plans/execution-roadmap/specs/100-role-scoped-prompts-and-tools.md](../../packages/web-server/plans/execution-roadmap/specs/100-role-scoped-prompts-and-tools.md)
- [packages/web-server/plans/execution-roadmap/specs/112-anti-god-layer-decomposition.md](../../packages/web-server/plans/execution-roadmap/specs/112-anti-god-layer-decomposition.md)
