# Position & Effect

Every `dice_check` carries two situational tags beyond the raw d20: Position (how recoverable failure is) and Effect (how much success delivers). The roll value alone is partial — these tags shape what the same roll *means* in different setups.

Full ruleset: [packages/web-server/prompts/greenhaven.md:373-405](../../packages/web-server/prompts/greenhaven.md#L373-L405). Implementation: [packages/web-server/src/tools/dice.ts](../../packages/web-server/src/tools/dice.ts).

## Position (controlled/risky/desperate)

How recoverable failure is.

- **`controlled`** — you set it up. Failure costs minor effort, you can try again.
  - Player ambushes from cover.
  - Player walks up calmly with coin in hand and offers it to Mikka.
  - Player describes a measured, deliberate seduction opener.
- **`risky`** (default) — standard exchange. Failure costs something concrete (HP, time, a String, narrative ground).
  - Player attacks an NPC face-to-face in a market.
  - Player tries to persuade with a half-true cover story.
- **`desperate`** — backed into a corner. Failure is catastrophic — defeated, exposed, the encounter spirals out of control.
  - Player charges with weapon raised, bleeding from prior wounds.
  - Player attempts a high-CHA persuasion at strings = -3 (wary).
  - Player picks the lock while the guard's torch turns the corner.

The narrator assigns Position from the prose. The player rarely says "controlled" — you read it. Setup, recoverability, and stakes drive the tag.

## Effect (limited/standard/great)

How much success delivers.

- **`limited`** — partial. The hit grazes; the seduction reads as flirty but uncommitted.
- **`standard`** (default) — clean exchange. As written.
- **`great`** — exceeds expectations. Damage is heavy; the partner is shaken in a way that lingers.

Examples from the prompt:
- A practiced, devastating caress → `great`.
- A standard kiss returned in kind → `standard`.
- A nervous, questioning brush of fingers → `limited`.

In combat, Effect tracks the prose's *quality* of attack — a clean, confident strike is `standard`; a desperate haymaker is `limited`; a perfect, deadly opening is `great`.

## Magnitude scaling

Effect scales the magnitude tool ([packages/web-server/prompts/greenhaven.md:394-397](../../packages/web-server/prompts/greenhaven.md#L394-L397)):

| Effect | Damage roll | Arousal_level delta |
|---|---|---|
| `limited` | halved (round down) | /2 |
| `standard` | as written | as written |
| `great` | doubled (cap at 60) | × 1.5 |

So a `dice_check(d=8, label='damage')` returning 6 with `effect='great'` lands as `damage(amount=12)`. Same roll, different prose, different consequence.

For `dice_check(category='check')` (skill / social / item checks), Effect doesn't apply directly — those checks are binary success/failure on DC. But Effect-tagged successes can imply *additional* outcomes the broker narrates: a `great`-effect persuasion success doesn't just convince the NPC, it leaves them admiring; a `limited`-effect lockpick success opens the door but takes longer (next turn the alarm trips).

## Failure narration

Position governs what failure *means*:

- **`desperate` failure** → narrate the catastrophe. Player stunned / disarmed / Mikka walks away cold. Call corresponding state tool.
  - Combat: `damage(target_id=<active player entity id>, amount=...)` from a counter, `apply_runtime_field_patch` for a stunned condition.
  - Social: NPC string drops by 1 + threshold band recomputes.
  - Lockpick: alarm fires + adjacent location's `surfaces[]` gets `noisy`.
- **`risky` failure** → narrate a concrete cost. Lost HP, lost initiative, lost String, lost narrative ground.
  - Combat: small counter-damage.
  - Social: -1 String.
  - Lockpick: wasted a turn but no alarm.
- **`controlled` failure** → narrate "no ground lost — try again". No state mutation.
  - The setup was secure enough that failure is just "retry next turn".

Position+Effect makes the SAME roll feel different in different setups. A `d20=10` is dramatic (success at DC 10 standard) vs disastrous (failure at DC 12 desperate) vs irrelevant (failure at DC 12 controlled — try again).

The broker passes Position and Effect explicitly on every `dice_check` ([packages/web-server/src/tools/dice.ts](../../packages/web-server/src/tools/dice.ts)). They surface on the `dice:rolled` SSE payload and on the EventCard for player visibility — so the player understands why the same number landed differently.

The Combat Director (spec 40) pre-computes both for combat turns; the briefing block's `position` and `effect` fields are used verbatim. For non-combat checks, the broker reads the prose and assigns. For ambient/check turns, the defaults (`risky` / `standard`) are usually right.

## Sources

- [packages/web-server/prompts/greenhaven.md](../../packages/web-server/prompts/greenhaven.md) — Position & Effect ruleset (lines 373-405)
- [packages/web-server/src/tools/dice.ts](../../packages/web-server/src/tools/dice.ts) — `dice_check` tool with position + effect args
