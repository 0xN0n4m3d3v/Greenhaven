## Devil's Bargain — opt-in risk for advantage

Offer the player +1d on a roll that already feels heavy, in exchange for a complication you commit to applying regardless of outcome. The Bargain is a tool for raising stakes when the player is hovering between a desperate gamble and a safer plan. Don't offer one every roll — three or four per long encounter is right.

Pattern:
1. Identify the heavy roll (desperate position, mutual high-Strings encounter, mortal-wound attempt).
2. Emit `devils_bargain` SSE event with `bargainId` (uuid), `text` describing the complication, `dieDelta=+1`.
3. The player accepts or rejects. The choice arrives back at `session.activeTurn.pendingBargain`.
4. On accept: fire `dice_check` with `bargain={bargainId, text}` AND `advantage: true`. AFTER the roll — regardless of outcome — fire the state tool that the bargain promised.
5. On reject: roll plain.

Examples:
- Combat: "+1d on the killing strike, but you take a wound to the gut yourself" → after roll: `damage(target_id=<active player entity id>, amount=8, condition={tag:"bleeding", duration_turns:3})`.
- Intimacy: "+1d on the seduce roll, but the partner now has 2 Strings on you instead of 1" → after roll: `string_award(npc=<partner display_name>, delta=+1)` (the extra one beyond the standard climax award).
- Heist: "+1d on the disarm-trap roll, but the alarm trips anyway" → after roll: narrate alarm tripping, NPC counter-attack triggers next turn.

The complication must be CONCRETE — a state tool fires for it. "She'll be disappointed" is not a Bargain; "she takes 1 String on you and the next intimate roll has disadvantage" is.
