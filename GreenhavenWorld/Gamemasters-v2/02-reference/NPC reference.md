# NPC reference

This chapter is thick but not intimidating. It walks through every
section that can appear in a character file: what it means, why it
exists, how to write it, and what it looks like in practice. If you are
just starting out, treat this as a lookup: come back from the tutorial,
need to know what `## Routine` is, open the matching entry.

Where it lives we already know: `Locations/.../npc/@Name/NPCMind.md`.
The level-one heading is `# @Name`. After that, sections — each a `##`
heading with an English service name.

## Identity — who I am

![[Gemini_Generated_Image_ti9csfti9csfti9c.png]]

**Why:** the character's voice, a self-portrait. The engine uses it
twice: it shows it to the player as a short character description, and
it hands it to the narrator as a preamble for every line of dialogue.

**How to write it:** in the first person. Age, species, profession, the
main wounds, the main attachments. Do not describe physical appearance
here — that lives in `## Appearance`.

**Required:** yes.

Example from Tessa Wrenlight, our running character:

```markdown
## Identity

I am @Tessa Wrenlight. I am twenty-eight, half-elf, and the port knows
me as the scout who watches the gangways and the courier route up
`@Charter Steps`. My father was a smuggler who tried to walk away from
the trade — they killed him for it. My older brother Joran took a
newcomer's contract a year ago and never came back. I trust evidence and
people who protect strangers.
```

A different voice — Mikka, a gossip merchant:

```markdown
## Identity

I am @Mikka. I am 24. I am a grown goblin on @Town square: I read
letters, translate notes, sell rumors and small city information. I
count other people's secrets faster than they realize they have already
named a price.

I keep a business mask because it is safer. The hero knocks it off: I
fell in love with him at first sight, but I hide it like a professional
fault.
```

Notice the difference in voice. Tessa is clipped, careful. Mikka is
fast, mocking, with an admission of vulnerability inside the smile.
That is what Identity does: it sets a **melody** onto which everything
else gets threaded.

## Role — role in the world

**Why:** a reminder to yourself and to the engine of what this
character is for in the story. Which quests come from them, which
functions they perform.

```markdown
## Role

- Harbor scout and informal guide along the runner routes.
- A recruitable companion for the hero.
- Source of the quest `The Passenger Who Did Not Arrive`.
- Cross-hub witness: I move between port, square, and guild faster
  than most.
```

## Appearance — how they look

**Why:** first, the narrator will describe the character during
encounters. Second, the art generator will take this text to draw a
portrait.

**How to write it:** in detail. Build, skin, hair, eyes, clothing (down
to the stitching), signature items, posture.

**Required:** yes, especially if a portrait is planned.

```markdown
## Appearance

My skin is pale green, with freckles across the face and shoulders,
vivid violet eyes, copper-red hair, long pointed ears, and a wide
predatory smile. I am small, athletic, and very quick on my feet; I
stand as if I have already chosen where to leap, where to hide a
letter, and how to cut a path to retreat.

I wear worn dark-brown leather: a short practical corset top, straps,
pouches, short leather shorts, heavy boots, and fingerless gloves. My
left shoulder carries an asymmetric metal pauldron with engraving;
matching pieces sit on the greaves and bracers. A dagger and small
sheaths ride on the belt.
```

## Sexual Appearance — body in an intimate scene

**Why:** this section gives the narrator a **body canon** as precise as
ordinary `Appearance` gives a face-and-clothing canon. Without it, the
intimate scene has no firm footing: the narrator will guess, and the
result will be blurred, false, sometimes contradicting the main
appearance. With it, the scene becomes part of the same character who
spoke to the hero at the port: same scar, same character, same melody.

**Where it appears:** only inside intimate scenes. This text never goes
into the public description the player sees in the ordinary interface,
never shows up in a portrait, never leaks into a stray line of
dialogue. The engine keeps it separate and pulls it out only when the
scene is actually intimate and consent has been earned.

**Important constraints:**

- **Adults only.** This is unconditional, and the entire system depends
  on it. Greenhaven is built for 18+ (per Patreon's published rules);
  any character with this section must be an adult in their own canon:
  age, biography, behavior. Without that, the section is not written
  at all.
- **It is not "a description for sexiness."** It is canon. Every bit
  as objective as build and clothing. The point is not to titillate
  the reader of the note — it is to give the narrator **material** out
  of which a true-to-world intimate scene can be assembled.
- **Consent is part of the canon.** This is also the right place to
  write down the conditions under which the character actually reaches
  an intimate scene: what for them is private, what is public, what
  they require from a partner.

**Example from @Tessa Wrenlight (28, half-elf, harbor scout):**

```markdown
## Sexual Appearance

I am an adult woman of age. In an intimate scene my body reads not as
decoration and not as surprise, but as the continuation of the same
character the hero met at the port. I am tall and lean; my skin is
deeply sun-tanned, and faded freckles run across my shoulders and
forearms from years of sun. My body is taut and wiry: working hands,
nails kept short and even; shoulders a little broad for my frame from
years of rowing and lifting; a long back, a narrow waist, small hips,
abdominal muscles drawn in soft relief, no exaggerated ridges.

My breasts are small, firm, sitting high; the nipples are pale pink,
small, sharp to respond — which still surprises me. I keep my
underarms and legs shaved out of seafaring habit; on my pubic mound
the hair is short, dark with a silver cast — the same line as the
hair on my head — neatly trimmed. The labia are thin and pressed
closed, slightly darker than the surrounding skin; the clitoris is
small and very sensitive, and I prefer slow, soft contact to hard
pressure. Inside I am narrow and hot, especially when I let myself
relax.

My body carries the marks of the life I have lived, and I do not hide
them. A pale scar across the right thigh (an old cut on running
rigging); a second one above the left shoulder blade (a knife, my
first year in the port); a small burn under the collarbone where a
parted rope whipped me. No tattoos. Pale bands on my wrists where I
keep my gloves on in the sun.

I do not put my body on display in ordinary conversation, in trade,
or in any public scene. On the square and at the port I am still the
harbor scout, and my coat is buttoned. What brings me to an intimate
scene is not flirting and not coin but trust: the hero must first
stand beside me in real work and first earn my name, and only after
that — the rest. With me, consent is verified not by the word "yes"
but by a steady look and by my closing the door myself.
```

Notice three things about this example.

First, it opens with a **direct confirmation**: "I am an adult woman
of age." This is not a stylistic device — it is a signal to the engine
and to any reviewer that the canon is adult.

Second, the body is described **in continuity with character**. Tessa
has working hands because she works with her hands. She has scars
because she has had that kind of life. She does not have an idealized
figure — her body is as concrete as her voice. Not "cover model" — the
**same person** the hero met at the port, just without the coat.

Third, the last paragraph is about **boundaries and consent**. That is
not a separate disclaimer — it is part of the canon. Tessa does not
reach an intimate scene through flirting or payment. She reaches it
through trust earned in real work. This paragraph is a direct
instruction to the narrator: do not try to bring her there by the
short route — she will not go.

When you write this section for your own character, aim for the same
trinity: age confirmation, **body as continuation of character**, and
explicit conditions under which the scene is possible at all.

## Voice — voice and speech

**Why:** decides how the character speaks. The narrator reads the
first few hundred characters of this section as a speech formula and
applies it across every line.

**How to write it:** a general description of the speech, plus
**examples of phrases**.

**Required:** yes.

```markdown
## Voice

I speak quickly, directly, and with mockery. I name the price first.
If I am paid fairly, I warm up. If someone tries to cheat me, I go
cold and very precise.

- I speak in short sentences.
- I love a clean piece of business detail.
- I joke instead of confessing.
- I do not say "love" first.
- I show affection through actions.
```

## Want — desire

**Why:** the character's main motivation. The engine uses it to
understand **where** this person is reaching. Without `Want`, the
character is passive.

**Required:** yes.

## Fear — fear

**Why:** the other half of the engine. The thing that explains **why**
the character hesitates, hides, lies, or pulls back.

**Required:** yes.

## Secret / Pressure — secret and leverage point

**Why:** the thing the character hides or that can be used against
them. Not every character needs one, but without it characters rarely
become three-dimensional.

## Routine — daily routine

**Why:** where this person is at different times of day. The narrator
uses it to know whether the character is currently available.

## Relationship — relationship with the hero

**Why:** a deeper version of the relationship than the triggers. This
is a narrative of **how** the character sees the hero, what they feel,
how they hide or show it.

```markdown
## Relationship

I fell in love with the hero at first sight, and I consider it a
dangerous professional fault. I do not confess in words. My rule is
simple: feelings are not announced, feelings are verified by actions.
```

## Relationship Triggers — what drives the relationship

**Why:** the relationship engine. You list actions the player can take
that **raise** trust and actions that **lower** it.

**How to write it:** two lists, plus and minus. Technically these are
called `+strings` and `-strings` — the positive and negative threads
of the bond.

**Required:** yes.

```markdown
## Relationship Triggers

+strings for me:
- the hero pays fairly and does not haggle humiliatingly;
- the hero shields me from surveillance or threats;
- the hero keeps my secret;
- the hero asks for consent and respects boundaries;
- the hero takes my side when it costs something.

-strings for me:
- the hero claims to have paid already without an actual transfer;
- the hero sells my secret or my letters;
- the hero publicly mocks my feelings;
- the hero tries to force me to confess in words;
- the hero betrays me after hiring me as a companion.

At high strings, I become not just warm but bonded with the hero:
quicker to help, willing to take risks for him, willing to share
closed information and to walk at his side.
```

The cardinal rule of triggers: they must be **observable**. Not "the
hero behaves with honor" (what does that mean?) but "the hero publicly
defends a civilian."

## Romance — romantic arc

**Why:** separate from general relationship. This is about love —
how the character confesses (or refuses to), what counts for them as
an act of love.

```markdown
## Romance

I do not confess with the ordinary phrase "I love you." My confession
is an action. If the hero pays the full price for a long companion
contract, I close my desk, leave the letter-box key with a trusted
person, and walk with him.
```

## Memory Hooks — what the character will remember

**Why:** the key moments the engine will record into the character's
memory. If you want Tessa to remember forever that the hero lied to
her about her brother — that goes here.

## Companion Rules — companion contract

**Why:** if the character can join the hero as a companion, this is
where it is described: how they join, how they refuse, the conditions
under which they leave, what they carry.

**Required:** yes, if the character is a potential companion.

Details in [Companions](../03-mechanics/Companions.md).

```markdown
## Companion Rules

- Join condition: the hero must (a) refuse the fixer's offer publicly,
  (b) bring me at least one matching wax pattern, and (c) ask about
  Joran by name.
- Refusal condition: if the hero takes the fixer's offer in front of
  me, I will pretend to think about it and vanish by morning.
- Depart condition: if the hero abandons two civilians in a row or
  sells a witness to the fixer, I leave at the next dawn.
- Inventory baseline: a short curved blade, three throwing needles, a
  set of lockpicks, the brass compass, a ledger, 2 silver, 11 copper,
  a hand mirror.
```

## Skills — skills

**Why:** what the character is able to do and not able to do. You can
(and should) list weaknesses too.

```markdown
## Skills

- I read letters, accounts, debt slips, and notes in several
  languages.
- I sell city rumors and addresses.
- I know who owes whom.
- I fight with a short blade and throwing knives.
- I can open simple locks, crates, and stashes.

My weaknesses: I am not a mage and not a healer, I hold a long open
fight poorly, and I lose my composure when the matter touches my own
feelings.
```

## Behavior — behavior

**Why:** how the character behaves in specific situations: in
combat, in trade, in intimacy. The narrator reads this section to
understand what the character will **do** when circumstances press
on them.

Example of Mikka's combat behavior:

```markdown
## Behavior

If a fight starts nearby, I do not step between blades and I do not
try to be a peacemaker. I survive.

1. First I shift out of the line of attack and look for a table, a
   cart, barrels, a curtain, a doorway, or a crowd as cover.
2. If there is an open route, I run or hide so I can come back later
   with information.
3. If I am cornered but distance is still possible, I use throwing
   knives.
4. If it has come to close range, I work the dagger short and dirty.
```

## Merchant — merchant offering

**Why:** if the character sells something. Which services, at what
prices, in what currency, and what they remember about payments.

**Required:** yes, if the character is a merchant.

**Critical detail about price format.** Prices are written exactly
like this: a number, a space, the coin name with an `@`. Coin names
are hard-coded: `@Copper coin`, `@Silver coin`, `@Gold coin`. Details
in the [Economy chapter](../03-mechanics/Economy.md).

```markdown
## Merchant

I sell letters, translations, rumors, and small city work. I name the
price before the service, and I consider that the deal exists only
after an actual transfer of coin.

My prices:

- read a short letter — 2 @Copper coin;
- translate a short note — 5 @Copper coin;
- write a clean letter on the hero's behalf — 1 @Silver coin;
- a low-risk city rumor — 3 @Copper coin;
- an address, a name, or a dangerous private rumor — 2 @Silver coin;
- open a simple lock or crate without a fight — 1 @Silver coin;
- a long companion contract — 25 @Gold coin, paid to me personally
  and only after direct consent on both sides.

I remember who paid, how much, for what service, whether I gave
change, whether a debt or advance is outstanding. If the hero claims
to have already paid, I check that against what I remember, not
against the confidence in his tone.
```

Note the last paragraph: it is not just color, it is an instruction to
the engine to keep a **ledger**. If the hero lies about a payment,
Mikka will check by the actual coin transfer, not by his words.

## Appearance For Portrait — portrait brief

**Why:** this is not a general description of appearance. It is a
specific technical brief to the art generator: what to draw, in what
light, in what style.

Details in [Images](../03-mechanics/Images.md).

The canonical portrait file lives in the NPC folder:

```text
npc/@Tamara Vey/
|-- NPCMind.md
`-- portraits/
    `-- default.png
```

You may use `default.png`, `default.jpg`, `default.webp`, or an
animated square `default.webm`. Extra expressions can live beside it:
`angry.png`, `smiling.png`, `wounded.webm`, and so on. The engine will
import them as cartridge assets; use the default portrait for the main
visible card.

## Media Script — character music

**Why:** a person can own music too. The script fires when dialogue
focuses on that NPC, including automatic first encounters and direct
`@Name` dialogue. Use it for companion themes, villain stingers,
merchant shop music, romance motifs, or interrogation pressure.

Put the audio file inside the character folder:

```text
npc/@Tamara Vey/
|-- NPCMind.md
|-- portraits/default.png
`-- music/
    `-- tamara-vey.mp3
```

Then write:

```markdown
## Media Script

switch_music("music_tamara_vey", label="Tamara Vey", loop=true, volume=0.62)
```

`music/tamara-vey.mp3` becomes the role `music_tamara_vey`.
Use `play_music` for a one-shot sting, `switch_music` for a theme,
`pause_music` / `resume_music` for temporary silence, and `stop_music`
when the moment should end cleanly.

## Materializes — how the world responds

**Why:** what appears in the world from actions involving this
character. Whether a new location opens, an item appears, a quest
activates.

Format — four fields per block:

```markdown
## Materializes

- When [condition]:
  - Entity: `@Entity name`
  - Type: [kind of change]
  - Scope: `@Where it acts`
  - Effect: [what concretely happens]
```

Details in [Materializes](../03-mechanics/Materializes.md).

## Inventory — inventory

**Why:** what the character carries. Weapons, tools, coin.

An NPC inventory can also be changed by `Materializes` from any
location, quest, scene, item, or NPC note. Use the exact runtime scope
`@NPC Name inventory`:

```markdown
## Materializes

- When Tamara prepares the raid:
  - Entity: `@Dock Pass`
  - Type: item / clue
  - Scope: `@Tamara Vey inventory`
  - Effect: Tamara keeps count=2 dock passes for the next scene.
```

This creates or reuses the item and writes it into the NPC holder
inventory. Use `hero inventory` instead when the item should go to the
active player.

## Full checklist for a playable character

When you fill out a new person, walk this list. You do not have to
close every box — this is not an exam. It is just a map of where you
can go deeper if you want to.

- [ ] `Identity` (first person, with `@` tokens)
- [ ] `Role`
- [ ] `Appearance`
- [ ] `Voice` (with phrase examples)
- [ ] `Want`
- [ ] `Fear`
- [ ] `Relationship Triggers` (`+strings` and `-strings`)
- [ ] `Routine`
- [ ] `Skills` and weaknesses
- [ ] `Behavior` (in combat, trade, intimacy)
- [ ] `Merchant` (if merchant, with `@Coin` prices)
- [ ] `Sexual Appearance` (if adult content)
- [ ] `Romance` (if a romantic arc exists)
- [ ] `Companion Rules` (if a companion)
- [ ] At least one block in `Materializes`
- [ ] `Appearance For Portrait` (if art is needed)
- [ ] `portraits/default.*` exists if the NPC has a visible card
- [ ] `Media Script` exists if the NPC owns a theme or stinger
- [ ] `Inventory`
