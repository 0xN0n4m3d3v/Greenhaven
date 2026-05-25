# Devil's Bargain

Opt-in risk for advantage. Offer the player +1d on a roll that already feels heavy, in exchange for a complication you commit to applying regardless of outcome. Spec 19. Full ruleset: [packages/web-server/prompts/greenhaven.md:455-471](../../packages/web-server/prompts/greenhaven.md#L455-L471). Server side: [packages/web-server/src/routes/sessionBargain.ts](../../packages/web-server/src/routes/sessionBargain.ts).

## When to offer

Three or four per long encounter is right; not every roll deserves a Bargain. The conditions:

- **Heavy roll already.** Desperate position, mortal-wound attempt, mutual high-Strings encounter.
- **Hovering between desperate and safer.** The player is choosing between a long-shot attack and falling back; Bargain pushes them to commit.
- **Concrete complication is available.** "She'll be disappointed" is not a Bargain. "She takes 1 String on you and the next intimate roll has disadvantage" IS — a state tool fires for it.

Don't offer one per roll. Don't offer one if the complication is hand-wavy. Don't offer one when the player already accepted last turn — give the rhythm a beat.

## bargainId protocol

Pattern from [packages/web-server/prompts/greenhaven.md:459-465](../../packages/web-server/prompts/greenhaven.md#L459-L465):

1. **Identify the heavy roll.** Desperate position, multi-stage quest climax, romance reveal.
2. **Emit `devils_bargain` SSE event** with `{bargainId: <uuid>, text: "...", dieDelta: +1}`. UI renders an Accept/Reject card.
3. **The player accepts or rejects.** The choice arrives back at `session.activeTurn.pendingBargain = {bargainId, accepted}`. Tracked on the active turn handle ([packages/web-server/src/sessionManager.ts:62-67](../../packages/web-server/src/sessionManager.ts#L62-L67)).
4. **On accept:** fire `dice_check` with `bargain={bargainId, text}` AND `advantage: true`. AFTER the roll — regardless of outcome — fire the state tool that the bargain promised.
5. **On reject:** roll plain.

The complication MUST be CONCRETE — a state tool fires for it. The Bargain is enforceable, not just narrative flavour. Examples:

- **Combat:** "+1d on the killing strike, but you take a wound to the gut yourself" → after roll: `damage(target_id=<active player entity id>, amount=8, condition={tag:"bleeding", duration_turns:3})`.
- **Intimacy:** "+1d on the seduce roll, but Mikka now has 2 Strings on you instead of 1" → after roll: `string_award(npc=Mikka, delta=+1)` (the extra one beyond the standard climax award).
- **Heist:** "+1d on the disarm-trap roll, but the alarm trips anyway" → after roll: narrate alarm tripping, NPC counter-attack triggers next turn.

## State tool firing on accept

The post-roll state tool is the Bargain's contract. Without it, the Bargain becomes a free advantage that the player learns to always accept. Three rules:

1. **Fire AFTER the dice_check, regardless of outcome.** The complication isn't conditional on the roll succeeding — that would defeat the whole "pay to play" structure. If the strike *misses* you still take the gut wound.
2. **Use a concrete state tool** — `damage`, `string_award` (negative or extra), `apply_runtime_field_patch`, `inventory_transfer`, `apply_surface`. The post-tool state must be visibly different from before.
3. **Audit it.** The Bargain accept fires the tool with a `bargain_id` arg if the tool accepts one (some don't yet — fall back to a `reason` containing "bargain:<id>"). The audit row in `tool_invocations` carries the bargain id so post-hoc analysis can correlate.

The frontend renders the Bargain card with both the offer text and the locked-in complication. After roll the EventCard shows the dice + the complication-tool's effect side-by-side — player sees what they signed up for.

## Reject path

If the player rejects, the dice_check fires plain (no advantage), no state tool. The `pendingBargain` is cleared. The narrative reads as the player choosing the safer route — narrator narrates accordingly.

## Frequency tuning

Three or four per long encounter is the prompt-stated bias. Operationally:

- Combat sequences: once at the climactic strike, maybe once during a turn-of-battle pivot.
- Social arcs: once at the reveal moment, maybe once during a high-stakes lie.
- Heists: once at the disarm/lockpick pivot, maybe once at the escape.

Reward Calibrator (spec 47) doesn't directly limit Bargain frequency, but its `inspiration_per_scene` setting reflects similar pacing — Bargains and Inspiration spends are the player's two ways to bend the dice math.

## Sources

- [packages/web-server/prompts/greenhaven.md](../../packages/web-server/prompts/greenhaven.md) — Devil's Bargain ruleset (lines 455-471)
- [packages/web-server/src/routes/sessionBargain.ts](../../packages/web-server/src/routes/sessionBargain.ts) — Bargain accept/reject endpoint
- [packages/web-server/src/sessionManager.ts](../../packages/web-server/src/sessionManager.ts) — `activeTurn.pendingBargain`
- [packages/web-server/src/tools/dice.ts](../../packages/web-server/src/tools/dice.ts) — `dice_check` with `bargain` arg
