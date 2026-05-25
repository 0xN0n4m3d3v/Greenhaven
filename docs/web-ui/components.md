# Component Directory Map

Greenhaven frontend components live under
[packages/web-ui/src/components/](../../packages/web-ui/src/components/). This
page maps the current directory roles; source files remain the contract for
props and state shape.

## adventure

Adventure rail/cards and accept/ignore UI for the durable adventure queue.

## atmosphere

Visual and audio atmosphere pieces driven by mode, time of day, surfaces, and
`ambient:bed` events.

## banners

Transient full-width notices such as mode changes, player movement, dialogue
state, and world events.

## character

Unified full-sheet character creator and sheet widgets from spec 99. Current
creator files include:

- `creator/CharacterCreator.tsx`
- `creator/FullSheetPanel.tsx`
- `creator/SynthesisPanel.tsx`
- `creator/CardReviewPanel.tsx`
- `creator/commitCharacterDraft.ts`

Old Examiner conversation and step-wizard components are no longer active.

## chat

Canonical conversation UI: `MessageFlow`, `EventCard`, `ChatComposer`,
`DialogueBanner`, `BubbleMenu`, `PersonaBubble`, streaming token rendering, and
message context actions.

## choice

Choice surfaces for quest, adventure, and scene actions that should be selected
from the UI instead of typed as free text.

## cursor

Pointer and interaction affordance components.

## dice

Dice roll bubbles, compact dice state, and roll result presentation.

## loading

Loading quotes and transition state for first boot, cartridge load, and turn
latency.

## modals

Radix dialog overlays such as settings, recovery, debug, and character flows.

## npc

Nearby NPC cards, NPC rail entries, persona affordances, and quick mention
helpers.

## rail

Left/right sidebars for location exits, player state, companions, currency,
quest state, opportunities, and nearby entities.

## scene

Scene breaks, surface strips, location/scene artwork wrappers, and ambient
presentation.

## ui

Shared low-level UI primitives used by the feature directories.

## Sources

- [packages/web-ui/src/components](../../packages/web-ui/src/components)
- [packages/web-server/plans/execution-roadmap/specs/099-full-sheet-character-creator-consolidation.md](../../packages/web-server/plans/execution-roadmap/specs/099-full-sheet-character-creator-consolidation.md)
