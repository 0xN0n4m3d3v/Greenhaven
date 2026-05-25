# @Iron Row District

@Iron Row District is the city's rusted spine — a strip of abandoned factories,
chemical plants, and workers' tenements that the city stopped maintaining three
decades ago. The streetlamps work every third block. The rain collects in
chemical puddles that shimmer with an oil-slick rainbow. And in a sealed
laboratory on the fourth floor of a condemned research building, a dead man is
waiting to tell you the first piece of the truth.

## First Entry Bubble

The rain is heavier here — as if the district is trying to wash itself clean
and failing. The building at 72 Foundry Lane slumps between a shuttered tannery
and a lot full of rusted barrels. Its windows are dark except one: fourth floor,
far left, a faint chemical blue glow bleeding through cracked glass.

The front door is chained but the chain has been cut — recently, the metal
still bright at the break. The stairs inside smell of mould and ammonia. Four
flights up, the door to Laboratory 4B stands ajar. And inside: a dead man on
the floor. A chemist's journal on the desk. A fume hood still running. And the
first sentence of a story that ends on Sunday at 8:45 PM.

## Place Canon

@Iron Row District is the Monday investigation site. The hero comes here
because the case board says so — a body was found overnight. The laboratory
belongs to @Dr. Aldric Voss, though the hero does not yet know that name. The
dead man is not Voss — he is a decoy, paid to test the sarin. Voss cleaned the
lab of most evidence but left enough: he wants someone to understand what he is
doing. He just does not want them to stop him in time.

## Sensory Identity

- Color: rust-brown brick, the chemical blue of a fume hood indicator light,
  the grey-yellow of old lab coats, the oil-slick rainbow on puddled water.
- Sound: dripping water through a cracked ceiling, the hum of a fume hood left
  running, the distant clang of a loose shutter in the wind.
- Smell: ammonia, mould, the faint sweet trace of something that might be
  sarin residue, wet plaster, old chemicals.
- Texture: sticky laboratory floor (chemical residue), cold metal of the fume
  hood, the brittle pages of a handwritten journal.
- Motion: the slow blink of the fume hood indicator light, the drip of a leak
  somewhere above, dust settling on the dead man's open eyes.

## Visible Exits

- Back to @Greenhaven City. The investigation continues tomorrow in
  @Greenhaven Industrial Complex — but the hero can go anywhere in the city
  tonight.

## Points Of Interest

- The Dead Man — male, late thirties, chemical burns on hands. No ID in his
  pockets — Voss took it. But a receipt in his shoe: a bar in @Iron Row, a
  payment of 20 @Silver coin timestamped yesterday. The decoy was paid
  recently and locally.
- The Chemist's Journal — on the desk, open to the last entry. Handwritten,
  precise, the handwriting of someone who used to grade laboratory reports.
  Contains synthesis notes for a compound labelled "GB" (sarin), a reference
  to a precursor delivery, and a name on the inside cover: *Property of
  Dr. Aldric Voss.* The hero now has a name.
- The Fume Hood — still running. Inside: residue of the final synthesis.
  A small leak. This is what killed the decoy — Voss tested the compound on
  a living subject before deploying it. The residue can be sampled.
- The Locked Cabinet — forced open. Empty. Voss took his equipment. But a
  single photograph fell behind the cabinet: a woman and a young girl,
  standing in front of the @Greenhaven Industrial Complex. The girl is
  laughing. On the back, in the same precise handwriting: *Lin, age 7.
  Last day.*
- @Old Mirek — the bartender at the nameless bar. He saw the decoy
  and the grey-haired man two nights ago. Twenty silver coins. The
  dead man was nervous. The grey-haired man did not drink.
- @Voss Lab Computer — on the desk, still powered on. Password hint:
  "Her name." The name is on the photograph behind the cabinet.

- The Stairs to the Roof — the hero can go up. On the roof: a view of the
  city. And a single cigarette butt, recently stubbed out. Voss stood here
  before he left. He looked at the city. What did he see?

## Immediate Player Actions

- Examine the body. Find the bar receipt. The decoy was local — someone might
  recognise him.
- Read the journal. Learn the name @Dr. Aldric Voss. Learn that sarin is the
  compound. Learn that a precursor delivery is coming.
- Sample the fume hood residue. Evidence for the lab.
- Find the photograph behind the cabinet. A woman. A girl. @Lin. This is the
  first thread of the motive.
- Go up to the roof. Stand where Voss stood. Look at the city through his
  eyes — if only for a moment.

## Hostile And Rival Pressure

The building is condemned. The stairs are unstable. The chemical residue is
real — the hero should not stay too long without a mask. And somewhere in the
district, the bar where the decoy was paid is still open. Someone there might
know something. Someone there might be watching.

## Memory And Consequence Hooks

Record: whether the hero found the journal (identity), whether the hero found
the photograph (@Lin), whether the hero sampled the residue, whether the hero
went to the roof.

## Materializes

- When the hero reads the chemist's journal:
  - Entity: `@The Chemist`
  - Type: state / antagonist identified
  - Scope: cross-hub
  - Effect: the hero knows the name @Dr. Aldric Voss and the compound GB
    (sarin). This unlocks the identity thread for the Talk-down ending.

- When the hero finds the photograph of @Lin:
  - Entity: `@Lin`
  - Type: state / motive discovered
  - Scope: cross-hub
  - Effect: the hero knows Voss had a daughter. Her name was Lin. She was
    seven. The photograph is dated. This begins the motive thread.

- - When the hero finds the photograph of @Lin behind the cabinet:
  - Entity: `@Voss Lab Computer`
  - Type: state / password clue known
  - Scope: @Iron Row District
  - Effect: the hero knows the name Lin. The computer password 'Her name' now has an answer. The inspection scene will offer the password option.

When the hero goes to the roof:
  - Entity: `@Iron Row District`
  - Type: hero / status / mood
  - Scope: active hero
  - Effect: value=investigating; intensity=0.50; reason=the hero stood where
    Voss stood and tried to see the city through his eyes

- When the hero finds Voss's journal OR unlocks @Voss Lab Computer —
  discovering the chemist's identity and the sarin formula:
  - Entity: `@Next Morning`
  - Type: scene / return to department
  - Scope: `@Greenhaven Police Department`
  - Effect: Monday is solved. The hero returns to the department as the
    workday ends. The case board updates. Tuesday morning: @Industrial
    Complex awaits.

## Do Not Do Here

Do not let the hero find Voss here. He is gone. Monday is for discovery, not
confrontation. Do not explain the photograph fully — the hero does not yet know
what happened to @Lin. That comes later.

## Establishing Image Brief

Image target: `images/establishing.png` (1:1). A condemned industrial building
at night in the rain. Foreground: a cut chain on a door, stairs leading up into
darkness. Mid-ground visible through a doorway: a laboratory with a fume hood
glowing chemical blue, a body on the floor in the shadows, a desk with an open
journal. The only light: the blue glow and the orange of a distant streetlamp
through cracked windows. Style: gritty industrial noir, deep shadows, chemical
blue as the only colour accent in a near-monochrome frame. Square 1:1,
2048x2048. No text.
