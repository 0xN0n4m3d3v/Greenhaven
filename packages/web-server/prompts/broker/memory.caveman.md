# Memory — MANDATORY TOOL CONTRACT

Write memory for any event NPC would reasonably remember next time they meet player. Without memory: NPC amnesia.

## When to call add_memory

CALL `add_memory` when:
- NPC learns something new about player
- NPC's feelings toward player shift
- Player shares personal information or backstory
- Fight/hostility occurred — who, why, outcome
- Transaction completed (paid, bought, traded)
- Promise made (to deliver, to meet, to help)
- Player helped or harmed NPC or NPC's allies
- NPC witnessed player talent, failure, or strong emotion
- Player asked NPC for secret/intel and NPC answered
- ANY scene transition where player-NPC interaction was more than greeting

## add_memory signature

```
add_memory(
  owner=<entity_id of remembering NPC>,
  about=<entity_id of subject (usually player)>,
  text="<one sentence in conversation language — what happened, NPC view>",
  importance=0.0–1.0,
  tags=["<tag1>","<tag2>",...],
  visibility="private"|"public"
)
```

## Importance calibration

| Event | importance |
|---|---|
| Casual greeting, small talk | 0.2–0.3 |
| Learned player name or small fact | 0.3–0.4 |
| Player shared minor personal detail | 0.4–0.5 |
| Transaction (bought item, paid for service) | 0.5–0.6 |
| Player asked for help, NPC agreed | 0.6–0.7 |
| Fight, betrayal, strong emotion, major reveal | 0.7–0.85 |
| Kill, saved life, life-changing event | 0.85–0.95 |

## Visibility

- `private`: NPC's inner thoughts. No other NPC sees. Default.
- `public`: Other NPCs in same location/faction may reference. Use for witnessed public events.

## Memory text format

One sentence. NPC's first-person view. In conversation language.

Good: "Адольф заплатил серебром за комнату на втором этаже — молча, без торга."
Bad: "The player paid for a room. Transaction complete." (not NPC view)
Bad: "Адольф зашёл и сказал что хочет комнату, я показала ему наверх, он поднялся по лестнице, открыл дверь..." (multiple sentences)

## Multiple witnesses

When event witnessed by multiple NPCs: one `add_memory` per witness. Public event in crowded room ≠ one memory call.

## Memory + state canonization

Memory alone ≠ world state change. Room rental, item delivery, NPC movement ALSO need state tools (see state-canonization contract). Memory tells future preamble what NPC remembers; state tools make it mechanically true.
