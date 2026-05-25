# Incident — 2026-05-13 — narrative state drift

## What broke (player report)

Adolf made a plan with Mikka: she rents a room on the second floor of
Ale & Eats, he walks away into the crowd, returns through the window at
night to ambush their pursuers. Mikka narrated "беру комнату на втором
этаже" and went off to "забронировать у Меидри". Adolf then walked over
to Innkeeper Dory and asked her to smuggle him up the back stairs to
Mikka's room.

Dory's first response: detailed help — gave him a knife, described the
back staircase, identified Mikka's room as "third door on the right with
the copper handle", and authored a signal protocol (dropping a tray of
mugs at the back entrance if pursuers showed). Looked perfect.

Dory's NEXT response: full reversal. "Mikka doesn't live on the second
floor. She doesn't live here at all. She keeps a corner at the market
square. No one named Mikka stayed here. I'd remember a goblin with red
braids." The NPC re-evaluated her own previous turn and contradicted it.

The player feels NPC amnesia / world incoherence.

## Class of bug — narrative state drift

The prose claimed an event (Mikka rented a room at venue 201019) that
**did not materialize as a state change in the DB**. No tool was called
to canonize the rental. Dory's preamble therefore reflects the actual
DB state (Mikka still pinned to home_id=201236 Market Square, no current
guests at Ale & Eats, no `record_location_memory` for the room
transaction). Two preamble signals fight each other:

- **Recent dialogue** (hot window) shows Mikka's claim out loud.
- **Structured state** (entities profile, location runtime, occupancy
  memory) shows nothing about a rental.

The broker oscillates: first turn it trusts the prose (helpful, plays
along), next turn it trusts the structured state (corrective, denies).

This bug is **not** a memory bug, **not** a classifier bug, **not** a
voice-warden bug. It's a **canonization gap**: state-changing prose
ran without state-changing tools.

## Evidence (log trace, turn 20:05:22)

```
turn-XXXX broker.tool #1 add_memory(owner=Mikka, about=Адольф,
  text="беру комнату на втором этаже...", tags=[plan,night_ambush,…])
broker.exit tool_calls=1 [add_memory]  prose_chars=750  WILL_TRIGGER_SYNTH_FALLBACK
synth-v2 narrate "Договорились, комната вторая, окно выходит в переулок..."
```

What is missing:

- No `record_location_memory(location=201019, text="Mikka rented room 2 upstairs", tags=["occupancy"])`
- No `apply_runtime_field_patch(owner=201019, field=current_guests, ...)`
- No `set_actor_status(actor=Mikka, kind=temporary_room, at=201019, room_number=2)`
- No `inventory_transfer(from=Mikka, to=Innkeeper Dory, item="Gold Coin", count=…)` for the rental fee
- No `add_memory(owner=Innkeeper Dory, about=Mikka, text="took room 2…")`

The personal memory **on Mikka herself** was written. The world around
her did not get the update. Dory was therefore correctly ignorant.

## Why this happens broadly

Mikka is the visible case. The same pattern can break any of these
diegetic moments:

| Prose claim | Missing tool |
|---|---|
| NPC rents a room from another NPC | `record_location_memory` + (optional) `inventory_transfer` for fee |
| NPC promises to deliver an item later | `add_memory(visibility=public)` on the OTHER NPC about the promise; not just self |
| NPC moves to another location to wait | `set_actor_status(at=<loc>)` or `apply_runtime_field_patch(owner=NPC,current_location_id=<loc>)` |
| NPC takes a side errand "I'll be back in an hour" | `set_actor_status(busy_until=<turn+N>)` |
| NPC leaves party | `set_companion(action="stop_following")` (currently relied on) |
| NPC accepts a deal/contract | `create_quest` / `advance_quest` |
| Player and NPC agree to meet later | location memory at the agreed venue + private NPC memory |
| Information is shared with a third NPC | `add_memory(owner=<the third NPC>, about=…)` so they know next time |

Each of these is **already supported** by an existing tool. The gap is
**discipline**: the broker prompt doesn't list these state-change types
exhaustively, so the model writes prose, fires one or two tools, and
moves on. Anything not in the personal memory of the speaking NPC
vanishes.

## Fix plan

### 1. Prompt enforcement — new `state-canonization.md` fragment

Add a broker prompt fragment that enumerates the **physical/social
state changes that MUST land as tool calls BEFORE narrate**. Loaded in
every mode (alongside `memory.md`). Lists the table above with explicit
examples. The fragment opens with a contract:

> Prose is not canon. Tool calls are canon. A scene-changing event in
> prose without a matching tool call is invisible to the world from the
> next turn onward. Other NPCs will not know. The location will not
> know. The next morning will not know.

### 2. Per-location occupancy ledger

Add a runtime convention: any venue that can house transient guests
(inn, brothel, tavern, room-renting locations) keeps a
`profile.current_guests` runtime field, plus a tag `accepts_guests:true`.
The `record_location_memory` tool already covers the human-readable
side; we surface it explicitly in DIALOGUE PARTNER preamble for the
venue's innkeeper and other resident NPCs. Mikka's recruitment quest
gets a sample stage that calls it.

### 3. Post-narrate claim sweeper

A new post-turn agent `narrativeClaimSweeper` reads the just-emitted
narrate, extracts diegetic state-change claims (NPC moves, room rentals,
deals, deliveries, contracts), checks whether matching tool calls fired
in `toolHistory`, and:

- If a match exists → silently OK.
- If not → emit a `claim:uncanonized` GUI event AND write a private
  memory to the speaking NPC: "I told the player I'd do X but the world
  doesn't know yet — next turn, fix this with `<recommended_tool>`."

This is a discovery layer, not enforcement (we don't reject the turn).
It surfaces the drift so the next broker turn can self-correct.

### 4. Companion + venue surfacing fix

When an NPC is a player's companion AND the player is at a venue, the
venue's NPCs see the companion in PEOPLE HERE. Already true via
`loadPresentPeopleAtLocation` (companionIds path). But the venue-side
NPCs don't currently get a hint that this companion-NPC may be
transacting with the venue. Add a small preamble hint: "PEOPLE HERE
include companions of @<player_name>; they may transact with your
venue. Pay attention to room/coin/item asks."

### 5. Mikka-specific `hard_broker_rules.on_room_rental`

Targeted: extend Mikka's `hard_broker_rules` block with an
`on_room_rental_with_player` rule that lists the exact tool sequence:
`record_location_memory` at the venue + `inventory_transfer` of the
rental fee + `add_memory(owner=Mikka, visibility=public)` about the
deal + `add_memory(owner=<venue innkeeper>, about=Mikka, visibility=public)` so the other NPC's preamble has it.

The Mikka block is already loaded in her DIALOGUE PARTNER preamble
(`hard_broker_rules` is a profile key). This is precedent — other NPCs
get similar blocks on a per-case basis.

## Rollout

1. **`prompts/broker/state-canonization.md`** — new fragment, with the
   table + the "prose is not canon" contract.
2. **`ai/prompts.ts`** — load `state-canonization.md` in every
   `BROKER_MODE_FRAGMENTS` mode (same pattern we used for `memory.md`).
3. **Mikka's profile** — extend `hard_broker_rules` via card-import
   round trip.
4. **Post-narrate claim sweeper** — new post-turn agent, fail-open. Can
   ship after items 1-3.
5. **Innkeeper preamble hint** — small docstring on `loadPresentPeopleAtLocation` / `renderDialogueState` for companion-NPC awareness.

## Out of scope (deferred)

- Full state-tracking DSL for NPCs (move_npc tool, scheduled events,
  timed promises). The current toolset is sufficient if used; we don't
  need new tools to fix this incident.
- Cartridge-level "accommodation policy" per venue. The
  `accepts_guests:true` tag can be added per-venue later as a content
  pass.
