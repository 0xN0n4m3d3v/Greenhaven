# Inspiration & Trauma

Two opposing currencies. Inspiration rewards in-character play; Trauma
accumulates from combat-resistance failures and quest catastrophes. Trauma at
4/4 → retire the character.

Migrations:
[packages/web-server/migrations/0028_sex_moves_and_trauma.sql](../../packages/web-server/migrations/0028_sex_moves_and_trauma.sql)
(trauma) +
[packages/web-server/migrations/0034_surfaces_and_inspiration.sql](../../packages/web-server/migrations/0034_surfaces_and_inspiration.sql)
(inspiration).

## Inspiration

BG3-style token reward for staying in character. Per
[packages/web-server/prompts/greenhaven.md:557-565](../../packages/web-server/prompts/greenhaven.md#L557-L565):

- **Cap 1** in MVP. Either you have an inspiration token or you don't.
- **Award** via `award_inspiration(reason)`
  ([packages/web-server/src/tools/inspiration.ts](../../packages/web-server/src/tools/inspiration.ts))
  when the player commits to in-character play _against their tactical
  interest_. A persuader who tells the awkward truth instead of the smooth lie.
  A barbarian who refuses to flee from the obvious losing fight. A tactician who
  reveals their plan to honor a vow.
- **Spend** via `spend_inspiration(reason)` for either:
  - **Re-roll** a `dice_check` once. Use the better result.
  - **Free advance** — short-circuit a stage-objective failure into a soft-fail
    that still progresses the quest.

The Reward Calibrator (spec 47) emits `inspiration_per_scene` 0/1/2 — usually 0,
lean toward 0 unless a Devil's Bargain or genuine heroic moment. Broker can
override with `calibrator_override_reason`.

Events:

- `inspiration:gained` SSE — payload `{playerId, reason, current}`.
- `inspiration:spent` SSE — payload `{playerId, reason}`.
- Frontend EventCard variants render with teal styling.

The token is per-player, not per-NPC — it's the player's resource, regardless of
the scene. Stays through `reset-world`'s player wipe (well, removed with the
player, but a fresh player starts with 0).

## Trauma

Per-player permanent accumulator. Schema: a `trauma` runtime field with
`value_type='json'`, scope `'permanent'`, default `[]`
([packages/web-server/migrations/0028_sex_moves_and_trauma.sql:62-78](../../packages/web-server/migrations/0028_sex_moves_and_trauma.sql#L62-L78)).
Each entry is a tag string.

Awarded for combat-resistance failures and quest catastrophes:

- Failed death save flow (3 failures before 3 successes).
- Character witnesses or commits a trauma-tagged event (the cartridge author
  tags via quest `failure_conditions`).
- Survives a desperate-position failure in a high-stakes encounter.

Implementation: `apply_runtime_field_patch` with `op:append` on the player's
trauma field. Per the prompt convention shared with conditions and strings.

Each trauma tag is concrete:

- `'ambush-survivor'` — survived being mortally outnumbered.
- `'oath-broken'` — explicit broken oath.
- `'patron-failed'` — failed to protect a sworn ally.
- `'mortal-wound-1'` — survived a mortal wound, first time.

The narrator reads `trauma[]` from preamble and threads it into character
behaviour: trauma 1 carries a quirk, trauma 2 a stronger flinch, trauma 3 a
visible scar in body language. The voice is the player's character speaking; the
engine just persists.

Trauma never decays in MVP. A future spec might add long-rest decay; until then,
accumulation is monotone.

## Retiring at 4/4

After 4 trauma entries, the character retires. The convention from the prompt
and the migration:

- `trauma.length >= 4` → soft-fail any subsequent dramatic encounter.
- The story SHOULD honor the retirement narratively — a coda, a final beat, a
  passing-of-the-torch scene.
- The save_slot quicksave fires once on the retirement event so the player can
  replay the final beats with a different choice.
- The frontend renders the trauma counter in `HeroVitals.tsx`
  ([packages/web-ui/src/components/rail/HeroVitals.tsx](../../packages/web-ui/src/components/rail/HeroVitals.tsx))
  with progressive visual decay (1/4 minor, 2/4 visible, 3/4 stark, 4/4 RETIRED
  banner).

Mechanically: at 4/4, broker is told via the preamble's `## TRAUMA` block that
the character is retiring. Subsequent narrate calls render the closing arc; the
player can start a new character through the unified character creator.

The retirement is permanent for that character but not for the _campaign_ — the
same world, NPCs, and locations persist for the new character. Strings reset
(they're per-player overlay, new player_id = clean state). Memory of the retired
character lives on in `npc_memories.about_entity_id` rows referencing the old
player id.

## Sources

- [packages/web-server/prompts/greenhaven.md](../../packages/web-server/prompts/greenhaven.md)
  — Trauma + Inspiration sections (lines 483-495, 557-565)
- [packages/web-server/migrations/0028_sex_moves_and_trauma.sql](../../packages/web-server/migrations/0028_sex_moves_and_trauma.sql)
  — trauma schema
- [packages/web-server/migrations/0034_surfaces_and_inspiration.sql](../../packages/web-server/migrations/0034_surfaces_and_inspiration.sql)
  — inspiration schema
- [packages/web-server/src/tools/inspiration.ts](../../packages/web-server/src/tools/inspiration.ts)
  — `award_inspiration`, `spend_inspiration`
