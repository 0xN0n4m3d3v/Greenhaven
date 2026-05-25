# Tool reference

All ~40 registered tools in
[packages/web-server/src/tools/](../../packages/web-server/src/tools/), grouped
by domain. Each entry: name, args (Zod), what it does in 1-3 sentences, SSE
side-effects, failure modes.

For the dispatch / audit machinery see
[server/tool-system.md](../server/tool-system.md). For _adding_ a tool see
[00-overview.md](00-overview.md).

## Mutate

Generic state mutation across runtime fields.

- **`set_runtime_field`** —
  [packages/web-server/src/tools/runtime.ts](../../packages/web-server/src/tools/runtime.ts).
  Args: `{field_id, value, scope?, source?}`. Sets a single runtime field by id.
  Honours `scope_per_player` unless `scope` overrides it. Audited; emits no SSE
  on its own.
- **`apply_runtime_field_patch`** —
  [packages/web-server/src/tools/runtime.ts](../../packages/web-server/src/tools/runtime.ts).
  Args:
  `{patches: [{field_id, op: 'set'|'append'|'remove'|'merge', value, scope?}, ...], source?}`.
  Atomic multi-field write, used by intimacy scripted rules and quest reward
  bundles. Failure mid-patch rolls back the whole batch. Invalid field
  ids/values return structured suggestions with field metadata. Use only field
  ids returned by runtime context/tools; the Borek sex_move sentinel
  `value:"add_current_player"` is resolved to the active numeric player id
  before write.
- **`batch_mutate_world`** —
  [packages/web-server/src/tools/batchMutate.ts](../../packages/web-server/src/tools/batchMutate.ts).
  Args: `{reason, atomic?, operations: [{id?, tool, args?, depends_on?}]}`.
  Atomic wrapper for allow-listed mutation tools; every child still passes the
  standalone schema, validators, execution, and audit path. Rejects `narrate`,
  read tools, recursion, non-atomic mode, duplicate quest operations for the
  same player/quest, and deterministic conflicts before mutation. See
  [batch-mutation.md](batch-mutation.md).

## Read

Pure-read tools that surface preamble-out-of-frame data without committing
state.

- **`get_runtime_field`** — `{field_id}` → current resolved value (per-player
  overlay falls back to global default).
- **`query_entity`** —
  [packages/web-server/src/tools/entity.ts](../../packages/web-server/src/tools/entity.ts).
  `{entity}` → full entity row + every runtime field with `field_id`,
  `value_type`, `allowed_values`, current value, profile, tags, i18n. Deep dive
  when the broker needs more than the preamble.
- **`search_entities`** —
  [packages/web-server/src/tools/entity.ts](../../packages/web-server/src/tools/entity.ts).
  `{kind?, name_prefix?, tag?, limit?}` → list of matches. Used to find existing
  canon before spawning duplicates.
- **`query_inventory`** —
  [packages/web-server/src/tools/inventory.ts](../../packages/web-server/src/tools/inventory.ts).
  `{holder}` -> array of `{slug, item_name, category, quantity, equipped}`.
  Players read `player_inventory`; NPCs/containers read `inventory_entries`.
- **`summarize_relationships`** —
  [packages/web-server/src/tools/worldSensing.ts](../../packages/web-server/src/tools/worldSensing.ts).
  `{target, player?, limit?}` -> strings band, social band, compact
  memory/dialogue/tool evidence, unresolved tensions.
- **`evaluate_social_standing`** —
  [packages/web-server/src/tools/worldSensing.ts](../../packages/web-server/src/tools/worldSensing.ts).
  `{target, player?, limit?}` -> deterministic
  `hostile|neutral|friendly|intimate` band with cited evidence.
- **`get_recent_history`** —
  [packages/web-server/src/tools/worldSensing.ts](../../packages/web-server/src/tools/worldSensing.ts).
  `{session_id?, domains?, limit?}` -> bounded recent
  tool/quest/inventory/memory/chat events scoped to the current player.
- **`predict_consequence`** —
  [packages/web-server/src/tools/worldSensing.ts](../../packages/web-server/src/tools/worldSensing.ts).
  `{tool_name, args?, session_id?, limit?}` -> likely quest progress, risk
  flags, and unsupported predicates without mutating state.
- **`query_player_state`** —
  [packages/web-server/src/tools/progression.ts](../../packages/web-server/src/tools/progression.ts).
  `{player?}` → HP, XP, level, stats, conditions, current location/scene,
  dialogue partner, companions, surfaces, GM affordances.
- **`query_player_profile`** —
  [packages/web-server/src/tools/progression.ts](../../packages/web-server/src/tools/progression.ts).
  Player background, alignment, class, skills.
- **`query_memory`** —
  [packages/web-server/src/tools/memory.ts](../../packages/web-server/src/tools/memory.ts).
  `{owner_npc?, about_id?, tag?, limit?}` → ranked-by-salience NPC memory rows.
  Bumps `salience` on read for the matching ids (`bump_memory_salience` is
  called internally).

## Narrate

Spec 64 contract: `narrate` accepts optional `internal_monologue`, but only
visible `text` can reach the player. The hidden field is persisted, when
present, only as `chat_messages.payload.internal_monologue`; it is not emitted
as SSE `content`, not copied into `chat_messages.text`, not added to
`activeTurn.narrativeBuffer`, and is redacted as `[redacted]` in
`tool_invocations.args`. Movement Warden and Voice Warden validate visible
`text` only.

The visible-bubble tool. Final call of every turn.

- **`narrate`** —
  [packages/web-server/src/tools/narrate.ts](../../packages/web-server/src/tools/narrate.ts).
  Args: `{text, author, tone: 'narrator'|'npc'|'system', done?}`. Persists to
  `chat_messages`, streams via SSE `content` deltas, throws `StopExecution` when
  `done=true`. Pre-tool validators (Movement Warden + Voice Warden) gate it.
  Sanitises Stanislavski-analysis leakage from the visible text via
  `sanitiseNarrateText`.

## Combat

D&D-style combat math + status.

- **`damage`** —
  [packages/web-server/src/tools/combat.ts](../../packages/web-server/src/tools/combat.ts).
  `{target, amount, type?, source?}` → applies HP delta, emits `damage:dealt`.
  Returns `{defeated: bool, current_hp, max_hp}`. Defeated NPCs may auto-mark
  downed.
- **`heal`** —
  [packages/web-server/src/tools/combat.ts](../../packages/web-server/src/tools/combat.ts).
  `{target, amount, source?}`. Cannot exceed max_hp. Returns
  `{hp_before, hp_after}`.
- **`mark_downed`** —
  [packages/web-server/src/tools/combatDeath.ts](../../packages/web-server/src/tools/combatDeath.ts).
  `{target}` → flips `current_hp=0`, `downed=true`. Player at 0 HP enters
  death-save flow.
- **`death_save`** —
  [packages/web-server/src/tools/combatDeath.ts](../../packages/web-server/src/tools/combatDeath.ts).
  Roll d20: ≥10 success, <10 failure (nat 1 = 2 failures). 3 successes → stable;
  3 failures → permadeath / retire.
- **`stabilize`** —
  [packages/web-server/src/tools/combatDeath.ts](../../packages/web-server/src/tools/combatDeath.ts).
  External stabilisation (medicine check, healing, narrative beat). Resets death
  save counter.
- **`dice_check`** —
  [packages/web-server/src/tools/dice.ts](../../packages/web-server/src/tools/dice.ts).
  `{d, modifier?, dc?, advantage?, category, roller, label, target_id?, check_kind?}`.
  Rolls + emits `dice:rolled`. `category='combat'` bypasses cooldown;
  `category='check'` (default) is gated to once per (player, target_id,
  check_kind) per 24h. Cooldown returns `{ok:false, cooldown:true}`.

## Intimacy

- **`apply_intimacy_trigger`** —
  [packages/web-server/src/tools/intimacy.ts](../../packages/web-server/src/tools/intimacy.ts).
  `{trigger_tag, partner?}`. Looks up the matching `scripted_intimacy_rules`
  row; applies field_patches + string_delta + trauma_tag. Idempotent on
  `one_shot=true` rules. Emits `intimacy:trigger`. See
  [design/intimacy.md](../design/intimacy.md).

## Quest

Spec 64 contract: `create_quest.goal_text` is optional. When omitted or shorter
than 8 characters, the tool deterministically derives a goal from `title`,
`summary`, first stage title, giver/beneficiary, and the latest player message
in the session. The generated value is stored in `entities.profile.goal`,
emitted on `quest:created` as `goal`, and returned as `goal_text` with
`goal_text_generated=true`. No LLM is called inside the tool.

- **`create_quest`** —
  [packages/web-server/src/tools/quest.ts](../../packages/web-server/src/tools/quest.ts).
  `{title, summary, goal_text?, stages?, rewards?, tags?, auto_start?, spawn_entities?}`.
  Creates a `kind='quest'` entity, optionally spawns related entities
  (locations, items hidden_until_stage), and returns `spawned` as a display-name
  to entity-id map. Cartridge Steward (spec 48) gates it; emits `quest:created`.
- **`start_quest`** —
  [packages/web-server/src/tools/quest.ts](../../packages/web-server/src/tools/quest.ts).
  `{quest, player_id?, player?}`. Inserts `player_quests` row with
  `status='active'`. Repeats return `changed:false` and emit no duplicate
  `quest:started`.
- **`advance_quest`** —
  [packages/web-server/src/tools/quest.ts](../../packages/web-server/src/tools/quest.ts).
  `{quest, to_stage?, to_phase?, player_id?, player?}`. Updates
  `current_stage_id`, persists path-taken. Repeats/terminal quests return
  `changed:false` and emit no duplicate `quest:advanced`.
- **`complete_quest`** —
  [packages/web-server/src/tools/quest.ts](../../packages/web-server/src/tools/quest.ts).
  `{quest, outcome: 'completed'|'failed', player_id?, player?}`. Sets terminal
  status once, applies rewards once, and emits `quest:completed` only on the
  first transition.

## Movement

- **`move_player`** —
  [packages/web-server/src/tools/movement.ts](../../packages/web-server/src/tools/movement.ts).
  `{target_location_id, intent_source: 'user_command'|'follow_player'|'specialist_forced'}`.
  Updates `players.current_location_id`, emits `player:moved`. Auto-follows
  companions on `'user_command'`/`'specialist_forced'`. Movement Warden (specs
  46+51) hard-rejects narrate calls that teleport without this tool firing
  first.

## Companion

- **`set_companion`** —
  [packages/web-server/src/tools/companion.ts](../../packages/web-server/src/tools/companion.ts).
  `{npc, action: 'follow'|'stop_following', reason?}`. Manages
  `players.metadata.companions[]`. Idempotent. Emits
  `companion:added`/`companion:removed`. Auto-depart engine (spec 53) uses
  `set_companion(stop_following, reason='auto:…')` server-side when
  `profile.depart_when` matches; emits `companion:auto_departed` additionally.
- **`switch_dialogue_partner`** —
  [packages/web-server/src/tools/dialogue.ts](../../packages/web-server/src/tools/dialogue.ts).
  `{npc?: string|null}`. Sets/unsets `players.dialogue_partner_id`. Auto-fired
  by `narrate.ts` when an NPC speaks via the new author. Emits
  `dialogue:partner_switched`.

## Inventory

- **`inventory_transfer`** —
  [packages/web-server/src/tools/inventory.ts](../../packages/web-server/src/tools/inventory.ts).
  `{from|from_player_id, to|to_player_id, item, count}`. Atomic transfer between
  players, NPCs, locations, and containers. `from`/`to` accept holder display
  names or numeric entity ids; `item` accepts slug, display name, numeric item
  id, or numeric item entity id. Unknown keys are rejected. Emits
  `inventory:changed`; emits `currency:changed` for currency items.
- **`use_item`** —
  [packages/web-server/src/tools/inventoryExt.ts](../../packages/web-server/src/tools/inventoryExt.ts).
  `{item_slug, target_location?, target_entity?}`. Validates the target/effect
  before consuming. Supports `applies_surface` and `heal`; healing updates
  player HP, surface application appends `active_surfaces`.
- **`equip_item`** —
  [packages/web-server/src/tools/inventoryExt.ts](../../packages/web-server/src/tools/inventoryExt.ts).
  `{item_slug, equipped?}`. Equips idempotently and unequips by merging back
  into the unequipped stack, avoiding partial-unique-index conflicts.
- **`give_to_npc`** —
  [packages/web-server/src/tools/inventoryExt.ts](../../packages/web-server/src/tools/inventoryExt.ts).
  `{item_slug, npc, quantity?}`. Convenience player -> non-player transfer that
  decrements `player_inventory` and records the NPC/container side in
  `inventory_entries`.

## Surface

- **`apply_surface`** —
  [packages/web-server/src/tools/surfaces.ts](../../packages/web-server/src/tools/surfaces.ts).
  `{location?, kind: 'fire'|'oil'|'water'|'ice'|'darkness'|'fog'|..., duration_turns?, source?}`.
  Adds an environmental surface to the location's `surfaces[]` runtime field.
  Combo rules apply (oil + fire = burning, water + ice = slick). Decays
  automatically each turn via `decrementSurfaces`. See
  [design/surfaces.md](../design/surfaces.md).

## Player

Player-targeted progression and persistence.

- **`award_xp`** —
  [packages/web-server/src/tools/progression.ts](../../packages/web-server/src/tools/progression.ts).
  `{player_id?, player?, amount, reason, calibrator_override_reason?}`. Prefer
  `player_id` or omit it for the current session player; string `player` is
  legacy compatibility. Adds to `current_xp`; auto-levels-up on threshold
  crossing.
- **`change_stat`** —
  [packages/web-server/src/tools/progression.ts](../../packages/web-server/src/tools/progression.ts).
  `{player_id?, player?, stat_key, delta, reason}`. Prefer `player_id` or omit
  it for the current session player. Bumps a `player_stats` row.
- **`unlock_skill`** —
  [packages/web-server/src/tools/progression.ts](../../packages/web-server/src/tools/progression.ts).
  `{player_id?, player?, skill, rank?}`. Prefer `player_id` or omit it for the
  current session player. Adds or raises a skill rank.
- **`award_inspiration`** —
  [packages/web-server/src/tools/inspiration.ts](../../packages/web-server/src/tools/inspiration.ts).
  `{reason}`. Grants 1 inspiration token (cap 1 in MVP). Emits
  `inspiration:gained`. See
  [design/inspiration-and-trauma.md](../design/inspiration-and-trauma.md).
- **`spend_inspiration`** —
  [packages/web-server/src/tools/inspiration.ts](../../packages/web-server/src/tools/inspiration.ts).
  `{reason}`. Consumes 1 inspiration. Emits `inspiration:spent`.
- **`add_memory`** —
  [packages/web-server/src/tools/memory.ts](../../packages/web-server/src/tools/memory.ts).
  `{owner, about?, text, importance?, tags?}`. Inserts an `npc_memories` row
  with computed salience. NPC Voice (spec 43) post-processes for voice rewrite.
  Emits `memory:added`.
- **`bump_memory_salience`** —
  [packages/web-server/src/tools/memory.ts](../../packages/web-server/src/tools/memory.ts).
  `{memory_id, delta?}`. Manual salience bump (auto-called by `query_memory` for
  matching rows). Emits `memory:enriched`.
- **`string_award`** —
  [packages/web-server/src/tools/strings.ts](../../packages/web-server/src/tools/strings.ts).
  `{npc, delta, reason}`. Bumps the player↔NPC string by ±delta. Emits
  `string:changed` with `threshold_band`. See
  [design/strings-and-bands.md](../design/strings-and-bands.md).
- **`string_spend`** —
  [packages/web-server/src/tools/strings.ts](../../packages/web-server/src/tools/strings.ts).
  `{npc, amount, reason}`. Spends accumulated string credit for a narrative
  favour.
- **`create_entity`** —
  [packages/web-server/src/tools/entity.ts](../../packages/web-server/src/tools/entity.ts).
  `{kind, display_name, summary?, profile?, tags?, i18n?}`. Spawns a new
  cartridge entity. Cartridge Steward + Catalogue Scout gate / monitor. Emits
  `entity:revealed`.
- **`update_entity`** —
  [packages/web-server/src/tools/entity.ts](../../packages/web-server/src/tools/entity.ts).
  `{entity, patch}`. Targeted profile / tags / i18n update.

## Sources

- [packages/web-server/src/tools/entity.ts](../../packages/web-server/src/tools/entity.ts)
- [packages/web-server/src/tools/runtime.ts](../../packages/web-server/src/tools/runtime.ts)
- [packages/web-server/src/tools/inventory.ts](../../packages/web-server/src/tools/inventory.ts)
- [packages/web-server/src/tools/memory.ts](../../packages/web-server/src/tools/memory.ts)
- [packages/web-server/src/tools/progression.ts](../../packages/web-server/src/tools/progression.ts)
- [packages/web-server/src/tools/quest.ts](../../packages/web-server/src/tools/quest.ts)
- [packages/web-server/src/tools/dice.ts](../../packages/web-server/src/tools/dice.ts)
- [packages/web-server/src/tools/combat.ts](../../packages/web-server/src/tools/combat.ts)
- [packages/web-server/src/tools/narrate.ts](../../packages/web-server/src/tools/narrate.ts)
- [packages/web-server/src/tools/strings.ts](../../packages/web-server/src/tools/strings.ts)
- [packages/web-server/src/tools/surfaces.ts](../../packages/web-server/src/tools/surfaces.ts)
- [packages/web-server/src/tools/inspiration.ts](../../packages/web-server/src/tools/inspiration.ts)
- [packages/web-server/src/tools/combatDeath.ts](../../packages/web-server/src/tools/combatDeath.ts)
- [packages/web-server/src/tools/inventoryExt.ts](../../packages/web-server/src/tools/inventoryExt.ts)
- [packages/web-server/src/tools/dialogue.ts](../../packages/web-server/src/tools/dialogue.ts)
- [packages/web-server/src/tools/intimacy.ts](../../packages/web-server/src/tools/intimacy.ts)
- [packages/web-server/src/tools/movement.ts](../../packages/web-server/src/tools/movement.ts)
- [packages/web-server/src/tools/companion.ts](../../packages/web-server/src/tools/companion.ts)
- [packages/web-server/src/tools/worldSensing.ts](../../packages/web-server/src/tools/worldSensing.ts)
- [packages/web-server/src/tools/batchMutate.ts](../../packages/web-server/src/tools/batchMutate.ts)
