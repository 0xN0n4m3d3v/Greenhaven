# Adventure Queue

Spec 89 adds the foundation for a stronger quester without letting random
generation mutate canon early.

## Planned Situation Engine

Spec 106 keeps the durable adventure queue, but stops treating random adventure
generation as "roll kind, make quest".
Greenhaven should first create or advance a situation thread: actors, motives,
clocks, owner/access rules, knowledge sources, clues, and item/location
provenance. Only a validated situation can project into a quest, entity spawn,
or visible adventure hook.

The intended stack becomes:

```text
post-turn snapshot + active situations/fronts/clocks
  -> Scenario Oracle/Pacer: seeded pressure, clock advancement, or skip
  -> Situation Materializer: JSON situation blueprint, no tools
  -> Scenario Integrity Arbiter: cause, ownership, access, knowledge, clues
  -> Adventure/Quest Projector: existing quest/entity/GUI paths
  -> existing adventure hook / accept / ignore flow
```

This keeps random adventures from becoming either flat random table entries,
player-gravity events, or mechanically valid but fictionally impossible quests.
Some events should be caused by the player. Some should be merely visible
nearby. Some should be unrelated world motion the player may choose to enter or
ignore.

Important rule: `hidden_until_stage` is only a visibility gate. It does not make
a private room, secret tunnel, stash, or NPC knowledge plausible by itself.

## Current Contract

- `adventure_queue` stores durable opportunities per session/player.
- `adventure_oracle_rolls` stores the deterministic oracle roll, selected kind,
  seed, sequence, table id, and candidate weights.
- The oracle is server-owned and uses seeded hashing, not `Math.random()`.
- Queue creation is always enabled as part of the gameplay loop.
- The oracle does not create quests, entities, items, memories, damage, rewards,
  or accepted hooks. It only records replayable queue metadata.
- Spec 90 materializes queued rows into validated blueprints. Spec 106 routes
  new materializer output through `SituationBlueprint` first, then projects to
  `AdventureBlueprint` only after deterministic scenario checks. A ready
  blueprint can be applied only through existing tools such as `create_quest`,
  `start_quest`, `advance_quest`, and `create_entity`; the materializer itself
  never calls tools.
- The materializer input includes the current location's owner/topology/access
  context, reachable exits, nearby entity access metadata, relationship bands,
  relevant memories, and active situation rows. These fields are the evidence
  base for owner/access/knowledge claims; the LLM should not invent missing
  evidence.
- Spec 91 exposes `ready` rows through ordered GUI cards and explicit
  accept/ignore routes. Ready rows are not auto-accepted.
- Spec 94 starts the phase-2 loop: a ready hook can also be accepted by
  natural player prose when the text clearly overlaps the visible hook/title.
  The same queue row is claimed through the existing accept/apply path before
  narration sees the updated context.
- Ready hooks expire after a deterministic turn TTL. Expiry marks the same
  queue row `expired` and emits `adventure:expired` only if the hook card was
  already visible.
- Accepted item-placement blueprints create item entities at a non-player
  holder/location through the existing entity path. They do not grant loot
  directly to the player.
- Accepted encounter blueprints create HP-bearing NPC setup in the player's
  current location and tag it as pending a visible roll. They do not deal
  damage or defeat any target at acceptance time.
- Situation-backed quests support projection modes:
  `create_new`, `attach_existing`, and `advance_existing`.
- `attach_existing` and `advance_existing` require `existingQuestId` and a
  matching quest cause source. They start/link the existing quest idempotently
  instead of creating a duplicate quest entity.
- `advance_existing` additionally requires `toStage` and advances that quest
  only after the hook is accepted.
- Existing-quest accepts append `profile.situation_links[]` to the quest
  entity, recording the hook, queue id, pressure type, cause sources, clocks,
  bridge summary, target stage, and spawned names.
- New `situation.locations[]` entries with `proposedName` project into
  `spawn_entities`. They must have topology; private or hidden locations also
  need owner and access/discovery reason. Existing-quest bridge spawns carry
  `profile.source_quest_id` and `hidden_until_stage` when provided.
- The same world-fact rules are enforced outside the materializer through
  `worldFactGuard`: direct `create_entity`, direct
  `create_quest.spawn_entities`, and adventure blueprint validation reject new
  locations without `profile.topology_parent_id`, hidden/private locations
  without owner/access cause, parent-owner bypasses, and hidden items without a
  holder/provenance.
- `context_snapshot.language` stores the explicit UI/player language for the
  turn. This selected language is authoritative for deterministic fallback
  adventure text. The Unicode script detector is only an emergency fallback
  when no selected language is available.
- `CartridgeSteward` validates adventure-created quest prose against the
  selected language script before falling back to recent player text. A player
  may type an English command in a Russian session, but generated quest
  title/summary/goal text must still follow the selected game language.
- UI quick actions use a language-neutral affordance contract. The server
  returns `message_key/message_vars`; the client renders the player-visible
  command in the selected language before submitting the turn. This prevents
  English travel/social/combat text from poisoning later language/script
  validation.
- Stale `materializing` rows are recovered on server startup and before the
  next scoped materializer claim. If the app closes while an adventure agent is
  running, the row returns to `queued` when no blueprint exists or `ready` when
  a blueprint was already persisted.

## Table

`greenhaven.adventure.mvp.v1` currently contains:

- `social_hook`
- `exploration_clue`
- `hidden_location`
- `item_discovery`
- `hazard`
- `ambush`
- `quest_complication`
- `downtime_rumor`

Entries are filtered by player level, current location, mode, active quest load,
recent combat/danger, and recent per-kind cooldown rows before weighted
selection. Spec 94 also records nearby entity ids/signature in the queue context
snapshot and folds matching nearby-signature rows back into cooldown lookup, so
the same local cast does not keep receiving the same hook class after the
generic recent window moves on.

## Player Routes

- `GET /api/player/:id/adventures`
- `POST /api/player/:id/adventures/:queueId/accept`
- `POST /api/player/:id/adventures/:queueId/ignore`

All three routes use the same player ownership model as the other player/session
routes. Accepting a ready row applies the validated blueprint, marks the row
`accepted`, emits `adventure:accepted`, and lets quest/entity events from the
existing tools remain part of the same durable GUI event stream. Ignoring a row
marks it `cancelled`, records baseline refusal evidence/consequence when routed
through the chat-turn ignore path, and must not materialize the refused quest or
spawns.

Natural prose acceptance uses the same service path as the explicit accept
route. It is language-agnostic: matching is based on queue id/title/hook token
overlap rather than localized verbs or protagonist aliases.

Chat-card accept and ignore actions now submit ordinary turns with
`actionId=adventure.accept:<queueId>` or
`actionId=adventure.ignore:<queueId>`. The server applies/cancels the exact row
before context construction, then the broker/narrator continuation produces the
visible NPC/world response.

## Ordering

When enabled after a turn, the oracle runs as a post-turn hook in the existing
presentation scheduler. If it emits `adventure:oracle_rolled`, that event is
deferred and released through the same `gui_events` slot ordering as Quest
Watcher/Pacer cards. There is no second GUI timeline.

The materializer now uses a chat-visible post-turn presentation slot. It can
build a ready blueprint asynchronously, but the hook card is released only
through the presentation barrier as `adventure:hook`, after earlier post-turn
slots and before later chat-visible turns from the same session become visible.
It claims only the queued opportunity for the same `turnId`; it must not
materialize an older queued row and insert that old hook under a previous
assistant bubble after the player has already moved on.

The frontend maps server `turnId` anchors back to persisted `messageId`s during
bootstrap/replay and live `narrate`/`turn.end`, so replayed adventure cards land
with the same turn instead of being appended as stale tail cards.

Expiry cards are also outbox-routed. They are quiet for hooks the player never
saw, and visible only for previously released `adventure:hook` rows.

The frontend also shows current `ready` hooks in the left rail through the same
list route. That rail is a current-state view only; it does not insert chat
events and it refreshes from the same adventure GUI/action signals as hook
cards.

## Support Fixture

`adventure_queue_end_to_end` verifies:

- fixed-seed enqueue;
- ready hook release through `gui_events`;
- no quest/entity mutation before accept;
- accept creates a tracked quest and hidden location;
- ignore cancels without mutation;
- replay order keeps `adventure:hook` before the accepted result.

`adventure_queue_phase_2` verifies:

- natural prose acceptance claims a ready hook and creates a tracked quest;
- stale ready hooks expire and emit one `adventure:expired` card;
- accepting an item placement creates one location-held item entity;
- accepting an encounter/ambush hook creates one HP-bearing enemy setup in the
  current location and does not change player HP before a visible d20 roll
  resolves harm.
