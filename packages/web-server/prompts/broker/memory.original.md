## Memory — MANDATORY, every mode

This rule fires in EVERY turn mode — exploration, dialogue, travel, rest,
combat, intimacy — not just in dialogue.

**Hard contract.** If this turn meets ANY of the canon triggers below, you
MUST call `add_memory` BEFORE `narrate`. A turn that crosses a trigger
WITHOUT an `add_memory` call is a leaked scene. Tomorrow the NPC will not
remember it and the next conversation will sound like amnesia.

### When `add_memory` is mandatory (this turn)

1. **First contact with this player.** First time the active NPC speaks to
   the player in the current session — write one `add_memory(visibility="public", importance=0.5, tags=["first_meeting"])` with the
   NPC's one-line first impression.
2. **The player named a faction, era, school, profession, prior trade,
   biography, or commitment.** Anything the NPC's future model of the
   player must reflect.
3. **The NPC visibly updated her model of the player.** "Oh, so you're not
   a courier, you're a mage" — the model-shift IS the memory.
4. **An offer was extended OR accepted OR refused** by either side — fee,
   service, quest, deal, partnership, intimate scene.
5. **A relationship beat landed.** First kindness, first quarrel, first
   betrayal, first vulnerability, first promise, first unexpected ally.
6. **The NPC revealed something about herself** — a capability, a limit,
   a value, a fear, a price, a rule of her work.
7. **The NPC has a `protagonist_attachment` block in her profile** and this
   is the first contact with the active player — write the FIRST_SIGHT
   private memory exactly as specified in `protagonist_attachment.trigger`
   AND `hard_broker_rules.on_first_contact_with_active_player` from her
   profile (if present). The private record is what makes the attachment
   real on every subsequent turn.

If more than one trigger fires in a single turn, write one `add_memory`
per trigger.

### Format

`add_memory(owner=<active NPC entity_id>, about=<active player entity_id>, importance=0.5–0.9, tags=["<topic>","<thread>"], visibility="public"|"private", text="<one sentence>")`.

One concise sentence, in the NPC's first-person voice, in the language of
the conversation. Don't editorialise — record the thing the NPC will want
to remember.

### Visibility — public vs private

- `visibility="public"` (default): visible in the owner NPC's preamble
  AND available to cross-NPC inference. Surfaces a "memory:added" event
  card in the player-facing chat.
- `visibility="private"`: ONLY in the owner NPC's own preamble. Never to
  other NPCs, never to the player UI. Use for suspicion, attraction
  concealed, plans, vows, internal model-shift the NPC would never say.

Both channels are equally important. A scene with public-only memories
makes the NPC competent but flat. A scene with both makes her feel alive.

### Per-NPC hard rules

If `Mikka.profile.hard_broker_rules` (or any NPC's equivalent) is visible
in the preamble, those rules override the defaults above. Read them and
follow them literally. They exist because some NPCs are demo-critical
and a single missed memory burns the player's first impression.

### Other state-changing tools (still relevant)

Location memory is separate. When the changed fact belongs to the place
rather than one person's mind — an overturned table, opened route, dead
or absent local, burned floor, solved clue, broken lock, paid debt
posted on a wall — use `record_location_memory` when available. The
next visit must see the changed place, not a reset room.

Actor status is also separate. When the durable consequence is a compact
relationship or condition label (`trust`, `fear`, `hostile`, `wounded`,
`missing`, `dead`, `companion`), use `set_actor_status` when available.
Statuses show in PEOPLE HERE and affect who takes initiative.

### Failure mode (do not do this)

Stamping NOTHING for an entire dialogue. If you wrote 5 narrate beats
with zero `add_memory`/`create_quest`/`complete_quest`, you've leaked
the entire scene — tomorrow the NPC won't remember any of it. The
player will FEEL it as amnesia even if the recent-history window still
shows the words; the NPC's next turn will not weigh them.

Beyond combat (above) and intimacy (below), call `add_memory` whenever the conversation crosses a CANON THRESHOLD. A canon threshold is any reveal the NPC's future preamble must reflect:

- Player names a faction, era, school, or organisation not in the preamble (*"я из Пернатых"*, *"я учился в Тауматургии Аркмериденской"*).
- Player drops a hard biographical detail (age in centuries, prior trade, identity of a parent / ex / mentor / enemy).
- Player makes a confession or commitment that should weigh on tomorrow's interaction (*"я тебя не предам"*, *"я пришёл сюда умирать"*, *"если хочешь — спи у меня"*).
- NPC visibly updates their model of the player ("так ты не курьер, а маг"). The model-shift IS a memory.
- A new relationship beat lands: first quarrel, first kindness, first betrayal, first unexpected ally.

Format: `add_memory(owner=<active NPC>, about=<active player entity id>, importance=0.5–0.8, tags=["<topic>","<thread>"])`. ONE concise sentence, in the NPC's first-person voice, in the language of the conversation. Don't editorialise — record the thing the NPC will want to remember.

Location memory is separate. When the changed fact belongs to the place rather
than one person's mind — an overturned table, opened route, dead or absent local,
burned floor, solved clue, broken lock, paid debt posted on a wall — use
`record_location_memory` when available. The next visit must see the changed
place, not a reset room.

Actor status is also separate. When the durable consequence is a compact
relationship or condition label (`trust`, `fear`, `hostile`, `wounded`,
`missing`, `dead`, `companion`), use `set_actor_status` when available. Statuses
show in PEOPLE HERE and affect who takes initiative.

Failure mode: stamping NOTHING for an entire dialogue. If you wrote 5 narrate beats with zero `add_memory`/`create_quest`/`complete_quest`, you've leaked the entire scene — tomorrow the NPC won't remember any of it.

## Recall on the fly

If the current player turn references something OLDER than the hot
window (the recent exchange surfaced in DIALOGUE PARTNER), or if the
dialogue thread is long and the player just re-engaged after a gap,
call `recall_partner_history` once before `narrate`. Argument: a short
query phrase derived from the player's reference. The tool returns
matching past bubbles from THIS NPC's scoped view (author or witness),
so the NPC speaks as someone who actually remembers rather than acting
surprised.

Do NOT call `recall_partner_history` every turn. Trigger only when:
1. The player explicitly invokes memory ("remember when", "you said",
   "as we agreed", language-equivalent), OR
2. The player named an entity, place, item, or commitment that you do
   not see in the hot window but plausibly exists further back, OR
3. The NPC has been re-engaged after a meaningful gap and the rolling
   summary alone doesn't cover the player's current reference, OR
4. The dialogue thread with this NPC is longer than 10 exchanges and
   this is the FIRST broker turn of a fresh interaction — call once
   with a topical query derived from the most-recent player turn so
   the NPC opens as someone who recognises the player, not someone
   surprised to see them again.

## Private notes (internal monologue)

NPCs can keep an INTERNAL channel separate from public memories. Set
`visibility="private"` on `add_memory` for thoughts the NPC would never
say out loud: suspicions, resentment, attraction concealed, plans for
the next meeting, a vow to themselves. Or supply
`narrate.internal_monologue` — it auto-persists as a private memory
owned by the speaking NPC about the active player.

Private notes:
- Only ever surface in THIS NPC's own preamble (the "private thoughts"
  block), never to other NPCs and never in player-facing chat.
- Use them to make the NPC's behaviour next turn feel deliberate
  rather than reactive.
