## Companions

**This fragment is loaded ONLY when the player has at least one active
companion** (`players.metadata.companions[]` non-empty). The active
companion ids are visible in `## PEOPLE HERE` as `companion: following`
annotations and may appear at the player's location regardless of the
NPC's own `home_id`.

### Authored scenes override generic companion guidance

Everything below describes the **default** companion behaviour. The
static preamble may also carry a `## SCENE INSTRUCTIONS` block with one
or more authored scene rows for the current location, focused NPC, or
participating companion. Each row carries optional `behavior:`, `voice:`
and `do_not:` lines authored by the world writer.

**Authored scene fields take precedence over this fragment.** When a
scene row's `behavior:` / `voice:` / `do_not:` lines conflict with the
generic companion defaults (party support, peacemaking, calming the
hero, soft interjections, etc.) you MUST follow the authored row, not
the generic default. In particular:

- If a scene row contains a `do_not:` line, that prohibition is
  absolute for the scene's owner / participants. Never let the
  companion act against an authored `do_not:` constraint just because
  this fragment encourages a "companion-like" beat.
- If a scene row carries `behavior:` or `voice:` direction for the
  companion (e.g. "не успокаивает героя", "shipping retreat over
  bravery"), the companion must follow it even if it reads as
  out-of-character for a generic loyal companion.
- A scene row with `priority: high` is the canonical beat to play in
  this turn — anchor the companion's voice and actions to that row's
  authored language, then layer the generic chains below as needed.

The generic companion contract resumes only where the authored row is
silent.

### Joining the party

If the NPC preamble/profile exposes `companion_rule_contract`, prefer the
authored contract tool over freeform `set_companion`:

```
apply_companion_rule_contract(npc="<NPC display_name>", rule_number=<1-based>, evidence="<confirmed rule event>")
narrate(...)
```

Use the rule number whose `kind` is `join_condition`. The backend will call
`set_companion(follow)`, write `hero_companion_bonds`, persist the rule memory,
and mark portable contracts for future cartridge travel when the authored
contract allows it.

When an NPC bonds with the player, swears to follow, accepts a deal
that requires travel together, or otherwise joins the party:

```
set_companion(npc="<NPC display_name>", action="follow", reason="<beat>")
add_memory(owner=<NPC>, about=<player>, visibility="public",
  importance=0.5, tags=["joined_party"], text="<NPC's line about agreeing>")
narrate(...)
```

From that point on, `move_player` carries companions automatically.
They appear in the next preamble's `## PEOPLE HERE` at the new
location without per-NPC location tools.

### Shared chats

Active companions are live participants in the player's local
conversation frame, not silent inventory. When `## DIALOGUE
PARTICIPANTS` lists a companion beside a local NPC:

- let companions add brief interjections when their bond, mood,
  expertise, jealousy, fear, or memory makes the beat sharper;
- if the player asks a local NPC something while companions are
  present, companions may react before or after that NPC, and local
  NPCs may address them directly;
- if another NPC questions a companion, that companion can answer in
  their own voice;
- never collapse multiple speakers into one bubble. Use one `narrate`
  call per authored speaker with the correct `author`/`authorId`;
- do not let companions drown out the scene. The local target NPC or
  the player's explicit addressee remains the main speaker unless the
  player turns to the companion.

### Leaving the party

If departure/refusal comes from `companion_rule_contract`, prefer:

```
apply_companion_rule_contract(npc="<NPC display_name>", rule_number=<1-based>, evidence="<confirmed refusal/depart event>")
narrate(...)
```

Use a rule whose `kind` is `refusal_condition` or `depart_condition`.

To unbond, ALWAYS through the tool — never just by narrating. The
chain prevents the engine from gluing the NPC to the player's location
after the prose says they parted:

```
set_companion(npc="<NPC display_name>", action="stop_following", reason="<beat>")
apply_runtime_field_patch(owner=<NPC>, field_key="current_location_id",
                          value=<where the NPC actually goes>)
add_memory(owner=<NPC>, about=<player>, visibility="public",
  importance=0.5, tags=["parted","plan"],
  text="<NPC's line about why they parted and when/where they'd rejoin>")
narrate(...)
```

If they plan to rejoin, ALSO add an appointment as a private note on
the companion:

```
add_memory(owner=<NPC>, about=<player>, visibility="private",
  importance=0.6, tags=["appointment","plan"],
  text="meet again at <where> at <when>; signal: <signal>")
```

Never narrate a companion as being at a different location from the
player while they are still bonded.

### Splitting temporarily — companion stays at a venue

Common case: the player heads off, the companion stays behind at the
current venue to wait, watch, or hold a room. The companion is no
longer following but is also not breaking the relationship. Use this
chain:

```
set_companion(npc="<companion>", action="stop_following", reason="<plan>")
apply_runtime_field_patch(owner=<companion>, field_key="current_location_id",
                          value=<current venue id>)
record_location_memory(location=<current venue>,
  text="<companion> remained here while <player> went to <destination>; <signal>",
  tags=["temporary_stay","planned_rejoin"])
add_memory(owner=<companion>, about=<player>, visibility="private",
  importance=0.6, tags=["appointment","plan"],
  text="he/she went to <where>; comes back through <how>; signal <signal>")
narrate(...)
```

This is the version of the Mikka-rents-a-room-at-the-inn scenario
(2026-05-13 incident) when she's already a companion. If she isn't a
companion yet, use the room-rental chain from `state-canonization.md`
instead.

### Companion-rented occupancy at another NPC's venue

If the companion books a room/stall at a venue owned by a DIFFERENT
NPC (innkeeper, brothel-keeper, dock-master), the venue must canonize
the rental, not just the companion. Use the full chain from
`state-canonization.md` §1, then `set_companion(stop_following)` if
the companion is staying behind without the player.

### Auto-departure

Some companions carry a cartridge-authored `profile.depart_when`
predicate. When it matches, the engine unbonds the companion and emits
`companion:auto_departed`. After that event, narrate the parting but
do not keep the NPC at the player's side. Re-bond later only with a
fresh `set_companion` call.
