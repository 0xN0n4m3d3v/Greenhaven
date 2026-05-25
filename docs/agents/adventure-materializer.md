# Adventure Materializer

Spec 90 adds `adventure_materializer`, an async queue-worker specialist for
turning deterministic `adventure_queue` rows into validated blueprints.

Spec 106 changes the planned direction: the current `AdventureBlueprint` path is
kept as the presentation/application layer, but new random content should first
pass through a `SituationBlueprint` and Scenario Integrity Arbiter. The
materializer should no longer be allowed to invent private rooms, secret
tunnels, stashes, NPC knowledge, or quest givers without owner/access/motive and
cause fields.

## Contract

- It consumes `adventure_queue.status='queued'` rows and claims them as
  `materializing`.
- It receives the oracle roll, player/location snapshot, active quests, nearby
  entities, current location topology/access context, reachable exits,
  relationship bands, relevant memories, active situation/queue rows, recent
  narrative, and duplicate candidates.
- It returns JSON only. New quester output should be a `SituationBlueprint`
  first, not a direct quest-first `AdventureBlueprint`.
- It never calls tools directly.
- The deterministic `AdventureArbiter` validates the blueprint before the queue
  can become `ready`.
- Spec 106: it returns or consumes a validated situation first, then projects
  into an adventure/quest blueprint.
- When the situation is a complication, clue, side route, or next step for an
  existing active/cartridge quest, `questProjection.mode` must be
  `attach_existing` or `advance_existing` with `existingQuestId`; it must not
  create a second quest for the same chain.
- Owner, access, topology, NPC knowledge, relationship, and memory fields are
  evidence for the situation layer. They are not decorative prompt context: if
  the evidence is absent, the materializer should choose a safer public,
  nearby, unrelated, or deferred pressure instead of inventing the missing fact.

## Ownership

The implementation is split so this specialist cannot become another
everything-module:

- `adventureMaterializer.ts` coordinates claim -> specialist -> situation
  validation -> projection -> blueprint validation -> queue state.
- `adventureMaterializerInput.ts` owns SQL/context gathering.
- `adventureMaterializerTypes.ts` owns the input/output type contract.
- `adventureMaterializerFallback.ts` owns deterministic fallback and bridge-safe
  fallback projection.
- `adventureMaterializerQueue.ts` owns stale recovery and current-turn claim
  polling.

## Safety

The arbiter rejects:

- schema-invalid output;
- queue id or adventure kind mismatch;
- duplicate/near-duplicate spawned entity names;
- item placements that grant directly to the player;
- ambush plans without `requiredVisibleRoll=true`;
- deadly danger without an encounter setup;
- immediately visible new locations that are neither hidden by quest stage nor
  mentioned as `@Name` in the hook;
- bridge projections that reference a missing/non-quest `existingQuestId`;
- `advance_existing` projections without `toStage`;
- new generated locations without topology; and hidden/private generated
  locations without owner and access/discovery reason.
- direct or projected dynamic spawns that bypass SituationBlueprint but still
  fail the shared `worldFactGuard`: missing topology, hidden/private access
  without owner/access cause, parent-owner mismatch, or hidden item without
  holder/provenance.

Spec 106 adds required rejections for unsupported private access, missing
location owner/topology, unsupported NPC knowledge, missing clue routes,
unsupported item provenance, and player-gravity events.

Applying a ready blueprint is a separate explicit step. Quest-bound content goes
through `create_quest(...spawn_entities)` for new quests, or through
`start_quest`/`advance_quest` plus linked `create_entity` spawns for existing
quest bridges. Existing quest bridges also append a compact
`profile.situation_links[]` entry to the quest with the hook, cause sources,
clocks, and spawned names. Standalone content goes through `create_entity`.
Spec 91 adds the player-facing accept/ignore routes and cards.
