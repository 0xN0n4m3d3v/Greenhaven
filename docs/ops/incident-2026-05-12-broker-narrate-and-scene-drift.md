# Incident — 2026-05-12 — broker narrate & scene-drift

Live build (`%APPDATA%\GreenHaven\logs\desktop.log`) from session
`2026-05-12 09:53–10:02 UTC`. Player: Адольф. Locations touched:
`Ale & Eats` (201011), `Meow Meow Paradise` (201012). NPCs:
`Meidri`, `Mii` (230012), `Karuruw` (230013).

Four defects observed. All four are systemic — not specific to this
scene/quest/NPC — and fix at the orchestration layer, not at the
cartridge layer.

## Defect 1 — `narrate` args streamed as a JSON string literal

### Evidence

```
09:57:06 WARN [broker.tool-error] narrate: Invalid input for tool
  narrate: JSON parsing failed: Text: {"text": "Сутулый, ..."}
09:57:06 INFO [broker.tool] #3 narrate args="{\"text\": \"Сутулый, ..."
09:57:06 INFO [broker.exit] tool_calls=3 […,narrate] narrate_handoff=true prose_chars=1197
```

Repeats at 10:02:01 on a different turn (Mii). Both turns recovered
via narrator-tier escalation (`deepseek-v4-pro`), with
`total_ms=32249`/`41189` and `NO_FIRST_DELTA` — the player sees the
bubble after ~35–40 s of silence.

### Root cause

The broker model emits the `narrate` tool call with `arguments` as a
**JSON-encoded string** (`"{\"text\": …}"`) rather than the object the
zod schema (`NarrateArgs` in `src/tools/narrate.ts:351`) expects.
AI SDK's `streamText` validates `input` against the tool's
`inputSchema` and fires `tool-error`. The broker stream (`runBroker`
in `src/ai/handoff.ts:59`) drops the call and proceeds without a
narrate handoff.

This is a known shape problem with DeepSeek-style chat models when the
system prompt frequently mentions JSON formatting: the model stringifies
arguments instead of structuring them. The AI SDK does not auto-salvage.

### Fix

Salvage in `runBroker`: when `tool-error` fires with `toolName === 'narrate'`
and the offending input is a parseable JSON string, recover the object
and forward it as `narrateRequest`. The narrator stage then runs on the
**original** turn instead of triggering a full re-roll, eliminating the
30–40 s extra latency.

Belt-and-suspenders: tighten `tools-mandatory.md` to spell out
"`arguments` are an OBJECT, not a JSON string".

### Surface area

Every `narrate` emission across every scene/quest/NPC. Universal fix
in the broker stage; no per-cartridge work.

---

## Defect 2 — dialogue partner stuck on previous NPC after narrated scene shift

### Evidence

Timeline:

| Time | Event |
|------|------|
| 09:54:50 | `narrate author=Mii` → `setDialogueParticipants(Mii)` (auto-engage) |
| 09:55:31 | Player "Иду наверх" → `mode=travel`, no `move_player` (no sub-location id for "upstairs") |
| 09:57:06 | `narrate author="Meow Meow Paradise"` describes Adolf entering Karuruw's room |
| 09:59:46 | `narrate author="Meow Meow Paradise" mentions=@Karuruw, @Адольф` — Karuruw speaks via location voice |
| 10:01:43 | Player replies (free_text). Router sees `dialogue_partner_id=Mii` → routes Mii. Mii responds while player is upstairs with Karuruw. |

### Root cause

`narrate` (`src/tools/narrate.ts:467`) auto-sets
`players.dialogue_partner_id` only when `authorKind === 'person'`. The
narrator authored the upstairs scenes as the **location**
(`tone='narrator'`, author=Meow Meow Paradise), so:

1. `dialogue_partner_id` was never updated to Karuruw, even though
   Karuruw is the only NPC speaking in the prose.
2. The model never called `switch_dialogue_partner` or `move_player`
   (there is no sub-location entity for Karuruw's room — interior
   rooms are prose-only).
3. Router (`turnRouting.ts`) and broker tool-set both read
   `dialogue_partner_id` and routed back to Mii.

This is a structural gap between **narrative scene** (the prose) and
**state-machine scene** (`dialogue_partner_id` + `current_location_id`).

### Fix

Two-layer fix:

1. **Code safety net in `narrate.ts`** — when narrate fires with
   `tone='narrator'` AND `dialogue_partner_id != null` AND prose
   `mentions` (already extracted by mention scanner) does **not**
   include the current partner, clear `dialogue_partner_id`. Letting
   the router fall back to exploration is preferable to misrouting to
   a partner who isn't in the scene.

2. **Prompt rule in `prompts/broker/voice-authoring.md` and
   `movement.md`** — when the player narratively moves out of earshot
   of the active dialogue partner (different room, leaving, walking
   away), the broker MUST call `switch_dialogue_partner` (to the new
   speaker or `'null'`) BEFORE narrate, even if no `move_player` is
   appropriate. NPC voice in prose without a partner switch is the
   bug.

### Surface area

Every scene with sub-locations described only in prose (taverns with
back rooms, brothel upper floors, dungeons with chambers, market stalls
inside markets). Universal; no per-cartridge work.

---

## Defect 3 — `adventure_materializer` schema rejects long `claim` (>240 chars)

### Evidence

```
09:56:07 WARN [agent:adventure_materializer] schema validation failed,
  fail-open. Issues: [{"code":"too_big","maximum":240,"type":"string",
  …"path":["causeSources",0,"claim"]}]
09:56:07 WARN [adventure_materializer] deterministic fallback unavailable
  for queue=30 reason=schema
```

`hidden_location` adventure roll dropped silently. Player got no
adventure card.

### Root cause

`SituationBlueprintSchema.causeSources[].claim` is `Text240 =
z.string().trim().min(1).max(240)` (`src/adventure/situationBlueprint.ts:13`).
LLM produced a 241+ char claim. Schema rejected hard. Fallback
(`adventureMaterializerFallback.ts:67`) only handles `quest_complication`
adventure kinds and a narrow set of bridge-tagged quests, so
`hidden_location` got no fallback.

### Fix

Convert `Text240` and `Text120` to **preprocess-truncate** variants:

```ts
const Text240 = z.preprocess(
  v => typeof v === 'string' ? v.trim().slice(0, 240) : v,
  z.string().min(1).max(240),
);
```

The LLM's overflow gets silently truncated to 240 chars before
validation. Schema still enforces non-empty + max bound for any code
path that constructs a SituationBlueprint manually. Player still gets
the adventure card.

This is a forgiving change with no observable regression: a 245-char
claim becomes a 240-char claim, all downstream renderers already
truncate for display.

### Surface area

`adventure_materializer` for **all** adventure kinds
(`hidden_location`, `quest_complication`, `exploration_clue`,
`social_hook`, …) — all share `SituationBlueprintSchema`. Universal.

---

## Defect 4 — broker emits prose without `narrate` handoff (`WILL_TRIGGER_SYNTH_FALLBACK`)

### Evidence

Two occurrences in this session:

```
09:55:50 [broker.exit] tool_calls=1 [query_entity] narrate_handoff=false
  prose_chars=945 — WILL_TRIGGER_SYNTH_FALLBACK
09:59:43 [broker.exit] tool_calls=3 [...] narrate_handoff=false
  prose_chars=1952 — WILL_TRIGGER_SYNTH_FALLBACK
```

`narrate:synth-v2` synthesises a `narrate` call from the broker's
prose buffer; player sees the bubble. Functionally OK but the broker
is repeatedly disobeying the "narrate is the final tool call" rule.

### Root cause

Same family as Defect 1: the model knows it should narrate but emits
the prose to the text channel instead of through `narrate(...)`. Either
the prompt under-emphasises tool-call discipline, or the model's
tool-use behaviour drops off after several state-only tool calls in a
single step.

### Fix

Defect 1's fix already recovers the equivalent failure mode (string
args). For pure prose-leak, the synth-v2 fallback is the safety net.
Tighten the broker stage override in `handoff.ts:BROKER_STAGE_BASE_OVERRIDE`
to underline: "Prose in the text channel is a bug. End every turn with
`narrate(...)` even if the only useful response is 'no change.'"

### Surface area

Universal. Already mitigated by synth-v2; the prompt tightening reduces
spurious 30 s+ latencies and chat-history noise.

---

## Rollout

1. Apply fixes in this order:
   - Defect 3 (schema preprocess) — independent, no behaviour risk.
   - Defect 2 code rule (`narrate.ts` auto-clear) — touch one tool handler.
   - Defect 1 (broker narrate-args salvage) — touch one orchestrator file.
   - Prompt edits for Defects 2 & 4.
2. Validate:
   - `npm --prefix packages/web-server run typecheck`
   - `npm --prefix packages/web-server run build`
   - `npm --prefix packages/web-server run content:linkage -- --fixture-mode=temp --write`
3. Manual playtest:
   - Repeat the upstairs flow at Meow Meow Paradise: Mii → upstairs
     → Karuruw conversation. Expect: free_text after entering
     Karuruw's room routes to Karuruw (or exploration), not Mii.
   - Trigger a hidden_location adventure roll and verify the card
     materialises even when the LLM produces a long claim.

## Out of scope (do not touch in this incident)

- Cartridge changes (no new sub-location entities for interior rooms).
- Router refactor (`turnRouting.ts` heuristics remain as-is — the gap
  is upstream of the router, in state).
- Narrator-tier model swap.
- New tool API.
