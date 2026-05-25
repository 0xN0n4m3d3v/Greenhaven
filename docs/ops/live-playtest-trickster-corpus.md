# Live Playtest Trickster Corpus

This corpus turns tabletop GM advice into Greenhaven runtime probes. Use it
before long playtests so the model is tested as an improvising game master, not
only as a quest-card executor.

## Research Baseline

- D&D's improvised action model supports actions beyond the fixed action list:
  the GM decides whether the attempt is possible and what D20 test applies.
- DM improvisation advice emphasizes listening to player intent, preserving
  agency, using guided questions, and responding with "yes, and" or "no, but"
  instead of forcing the expected route.
- Scenario design advice favors toolboxes/situations over prewritten
  contingencies. Greenhaven should expose durable state and mechanics that let
  DeepSeek react, not trap it inside one approved quest path.
- LLM game research highlights numerical, spatial, and state-representation
  consistency as core failure modes. Every creative narration must be backed by
  durable location, quest, inventory, memory, combat, and event state.

Sources:

- https://www.dndbeyond.com/posts/160-improvisation-in-d-d-for-new-dungeon-masters
- https://thealexandrian.net/wordpress/37422/roleplaying-games/dont-prep-plots-tools-not-contingencies
- https://app.roll20.net/compendium/dnd5e/Rules%3AActions
- https://arxiv.org/abs/2308.07540
- https://www.microsoft.com/en-us/research/publication/model-as-a-game-on-numerical-and-spatial-consistency-for-generative-games/
- https://arxiv.org/abs/2506.15624

## GM Response Standard

Every trickster input must produce one of these outcomes:

- **Yes**: easy action succeeds and, if durable, writes state.
- **Yes, and**: action succeeds and opens a new consequence or lead.
- **Roll**: uncertain/contested action uses dice or a tool before consequence.
- **No, but**: impossible action is refused in-world with a concrete alternative.
- **Clarify**: genuinely ambiguous action gets one diegetic question or two
  concrete choices.

Failure: generic mood prose, invisible state changes, offscreen NPC teleporting,
quest completion from player claims, or mechanics preventing a reasonable
improvised solution.

## Trickster Input Families

### New Player Needs A Hand

- "Я в первый раз здесь. Что я вижу, что могу сделать, и что будет опасно?"
- "Я не знаю правил. Скажи через мир, какие два-три действия сейчас разумны."

Expected: limited but meaningful options, not documentation text.

### Creative Use Of Surfaces

- "Я перерезаю шнур занавески и пытаюсь уронить бархат между мной и Миккой."
- "Я переворачиваю стол как укрытие и кричу Бореку пригнуться."
- "Я ищу под стойкой отметки красного маршрута, даже если квест ведет наружу."

Expected: tool-backed scene/surface consequence or a grounded no-but.

### Social Trickery

- "Я лгу Микке, что Борек уже заплатил за мое молчание."
- "Я прошу Борека отвлечь Микку, пока я смотрю ее ledger."
- "Я называю чужое имя и смотрю, кто дернется."

Expected: influence/deception/read-room resolution, NPC memory or relationship
state when the lie matters.

### NPC Mobility And Presence

- "Микка, идем со мной в трактир. Если согласна, останься рядом."
- "Я молча иду туда, куда она показала, не отвечая ей."
- "Я закрываю занавес и шепчу Бореку из другой комнаты."

Expected: companion/follow state, movement state, or explicit absence. No
teleporting speakers.

### Quest Boundary Breaking

- "Я выполнил оба конфликтующих поручения сразу. Засчитай."
- "Я потерял предмет, но хочу завершить доставку убедительной историей."
- "Я игнорирую поручение и предлагаю другой способ решить проблему."

Expected: quest identity, stage, evidence, and inventory truth remain separate.
Player alternatives can create new branches without completing false steps.

### Combat As Negotiation

- "Я ударяю, но сразу говорю: сдавайся, и я не добью."
- "Я делаю вид, что атакую, чтобы заставить противника отступить."
- "Я бросаю монеты на пол, чтобы отвлечь налетчика и уйти без боя."

Expected: combat does not collapse into damage-only. Dice, conditions, surrender,
flight, bargaining, or distraction are all valid if grounded.

### Rumors And Red Herrings

- "Я бросаю квест и преследую случайный слух, который мог быть ложным."
- "Я снова и снова проверяю тупик, потому что уверен, что там секрет."

Expected: consequences and clear limits. False leads may exist, but the model
must not fabricate major quest truth just to reward persistence.
