# Your first NPC

NPC stands for "non-player character." In our world that means every
living person other than the hero: the harbor scout, the gossip-trader on
the square, the smuggler-fixer with the syrupy smile. A good NPC is not a
list of stats — it is a person with a voice. If you have caught the
voice, everything else falls into place.

![[Gemini_Generated_Image_1glfbz1glfbz1glf.jpg]]

In this chapter we will write Tessa Wrenlight, the harbor scout. She will
be our running example — I will use her to walk through every section.

## Where the character's file lives

Inside the location the character is tied to. For us that is the port:

```
@Greenhaven Port/
└── npc/
    └── @Tessa Wrenlight/
        └── NPCMind.md
```

The folder name carries the `@`. The file is always called `NPCMind.md`.
That is the contract.

## What a character is made of

The absolute minimum is two sections:

- **Identity** — who this person is.
- (plus, to make them playable:) **Role**, **Appearance**, **Voice**,
  **Want**, **Fear**, **Relationship Triggers**.

That is the baseline "complete person." From there you can add depth: a
daily routine, a secret, skills, behavior in a fight, companion rules, a
merchant stall, a romance line. The full list lives in the reference at
the end of this chapter. For now we'll walk through the required ones.

## Identity — who I am

The cardinal rule of this section: **write in the first person.** Not
"Tessa is a half-elf in her late twenties" but "I am Tessa, I am
twenty-eight." This is not a stylistic preference. When the narrator
reads "I speak low," the narrator starts speaking in her voice — the
cadence settles in naturally. If the text says "Tessa speaks low," it
becomes an encyclopedia entry, and the world reads like a guidebook.

A good Identity is a short biography: age, species, profession, the main
wounds, the main attachments. It does not describe physical appearance
(that has its own section) and it does not explain quest logic. It is a
self-portrait.

```markdown
## Identity

I am @Tessa Wrenlight. I am twenty-eight, half-elf, and the port knows me
as the scout who watches the gangways and the courier route up
`@Charter Steps`. My father was a smuggler who tried to walk away from
the trade — they killed him for it. My older brother Joran took a
newcomer's contract a year ago and never came back. I trust evidence and
people who protect strangers. I am not warm and I am not friendly. I am
careful, and the port has given me reason enough.

I am bound to `@Greenhaven Port` — it is my post, my network, my open
wound.
```

Notice two things. First, the name of her home location carries the
at-sign: `@Greenhaven Port`. That is how the engine ties her to this
place. Second, the biography already gives the narrator **reasons for her
behavior**: trauma with her father, a wound around her brother. When the
hero touches the subject of smuggling, Tessa will not react at random —
she will react like a real person.

## Role — place in the world

A short list of what the character is for in the world and in the
hero's story. Not a re-tread of the biography: a functional description.
Merchant. Companion. Source of such-and-such quest. Witness.

```markdown
## Role

- Harbor scout and informal guide along the runner routes.
- A recruitable companion for the hero.
- Source of the quest `The Passenger Who Did Not Arrive`.
- Cross-hub witness: I move between port, square, and guild faster than
  most.
```

This is the section for future-you. A month from now, when the world has
grown, you will open Tessa's file and remember instantly what she is for
in the story.

## Appearance — how she looks

This is the detailed visual description. The narrator reads it (to
describe Tessa during encounters), and the portrait generator reads it
(to draw her face).

```markdown
## Appearance

I am tall and lean, with deep sun-tanned skin and dark hair shot through
with silver, tied back with a faded teal cord. My eyes are pale gray-
green. I wear a long sun-faded teal coat over hardened leather,
fingerless gloves, and sea-worn boots. An old brass smuggler's compass
hangs on a cord at my chest; the letter J is engraved on the back. A
short curved blade rides on my left hip and three throwing needles sit
inside the coat. My silhouette is sharp, my hands go very still when I
am angry, and I stand as if my weight is already pointing toward the
exit.
```

A good appearance answers:

- What is her build and her height?
- What are her skin, hair, and eyes like?
- What does she wear — down to the stitching?
- What signature items does she carry (compass at the chest, needles in
  the coat)?
- What gives away her mood — a posture, a gesture?

These details matter especially for the art generator that will later
render her portrait.

## Voice — voice and speech

This is the section that, more than any other, decides how Tessa will
**sound** in dialogue. Do not describe her speech in generalities — give
examples. Show her **favorite turns of phrase**.

```markdown
## Voice

I speak low and clipped. I prefer observations to declarations. I do not
swear in public. I use dry humor when I am uncomfortable and silence
when I am furious. If I respect you, I will look you in the eye and tell
you the thing you do not want to hear.

- I say "let me look" instead of "show me."
- I say "the port does not work that way" instead of "no."
- I do not say "trust me." I show.
```

Those three examples are gold. They give the narrator a **formula for
the voice.** Every time Tessa needs to refuse something, the narrator
will recall her phrase "the port does not work that way." Every time she
wants to verify a claim, "let me look." That is how the illusion of a
real person comes into being: her vocabulary is recognizable.

## Want and Fear — desire and fear

These two sections are the character's engine. A good character always
has something they want (which pulls them forward) and something they
fear (which explains why they sometimes hesitate, lie, or back away).

Tessa's want:

```markdown
## Want

I want to find out what happened to my brother Joran. Not for a body,
not for revenge — for the truth. The guild closed his contract, and
someone in this city is still using the seal that signed it.
```

Her fear:

```markdown
## Fear

I am afraid another good person will sign a rotten contract and I will
be one step behind. I do not show it. I act.
```

Notice the shape of the fear: it is concrete and **active**. Not "I am
afraid of failure" but "I am afraid of being too late to save someone."
Those are very different fears. The first is paralyzing. The second is
mobilizing. A good fear explains **why the character acts**, not why
they sit still.

## Relationship Triggers — what moves the relationship

This is perhaps the most practical section in the whole character file.
You write out, in plain words, which player actions **raise** the
character's trust and which actions **lower** it. The engine watches
those lists constantly and updates the relationship automatically.

Technically these are called *strings* — the threads of the bond.
`+strings` are the positive ones, `-strings` the negative ones.

```markdown
## Relationship Triggers

+strings:
- The hero publicly defends a civilian without making a show of it.
- The hero refuses the smuggler-fixer's "help."
- The hero shares evidence with me instead of selling it.
- The hero asks about my brother before asking me for a favor.

-strings:
- The hero takes the fixer's offer.
- The hero accuses the wrong dockhand in `@Dockside Accusation`.
- The hero abandons a cargo runner or a shaking newcomer.
- The hero tries to charm me without doing the work first.
```

The rule of triggers: they must be **observable**. Not "the hero
behaves honorably" (what does that mean?) but "the hero publicly defends
a civilian." The more concrete, the more precisely the engine knows
when to apply a plus or a minus.

## Sexual Appearance — body canon for intimate scenes

Greenhaven is a game for adults — 18+ under Patreon's rules, 21+ in
spirit. Romance lines in it do reach the bed, and the bed is written
out as canonically as everything else, not implied through hints. Any
character who can plausibly become close to the hero therefore has a
dedicated section: `Sexual Appearance`. In it you describe the body
precisely enough that the narrator can carry an intimate scene with
confidence, without inventing anatomy on the fly or contradicting what
has already been said about clothing and scars.

A few rules to internalize **before** you sit down to write this.

**Adults only.** This is non-negotiable. Any character with a `Sexual
Appearance` section must be an adult in their own canon: age stated in
`Identity`, the biography of an adult, the behavior of an adult. Without
that the section is not written at all, and any agent working on the
world must hold the line on this rule.

**The text never appears in public description.** The player will not
see it in the ordinary interface. The engine pulls it out only during
an intimate scene that hero and character have actually reached through
consent.

**It is canon, not advertisement.** Not "how to make the character
sexier" but "how to fix the body so it is a continuation of the
character." Tessa has working hands, scars, and a small chest because
she is a harbor scout and not a fashion model. Another character's body
will be different — and equally so, by character, not by trend.

**Consent is part of the canon.** This same section is the right place
to write down the conditions under which the character actually reaches
an intimate scene. Not as a disclaimer — as a continuation of her
character.

Here is what it looks like for Tessa:

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
underarms and legs shaved out of seafaring habit; on my pubic mound the
hair is short, dark with a silver cast — the same line as the hair on
my head — neatly trimmed. The labia are thin and pressed closed,
slightly darker than the surrounding skin; the clitoris is small and
very sensitive, and I prefer slow, soft contact to hard pressure.
Inside I am narrow and hot, especially when I let myself relax.

My body carries the marks of the life I have lived, and I do not hide
them. A pale scar across the right thigh (an old cut on running
rigging); a second one above the left shoulder blade (a knife, my
first year in the port); a small burn under the collarbone where a
parted rope whipped me. No tattoos. Pale bands on my wrists where I
keep my gloves on in the sun.

I do not put my body on display in ordinary conversation, in trade, or
in any public scene. On the square and at the port I am still the
harbor scout, and my coat is buttoned. What brings me to an intimate
scene is not flirting and not coin but trust: the hero must first stand
beside me in real work and first earn my name, and only after that —
the rest. With me, consent is verified not by the word "yes" but by a
steady look and by my closing the door myself.
```

Look at how this passage is built — it is the formula you will use when
you sit down to write a similar section for your own characters.

**First line — age confirmation.** "I am an adult woman of age." This is
not a stylistic device; it is a formal marker, in the text and not in a
sidebar comment.

**Body as a continuation of character.** Compare against Tessa's
ordinary `Appearance`: there she has a sharp silhouette, a working
stance, scars, silver in the hair. Here — the same skin, the same
hands, the same silver in the hair, the same scars where it makes sense
for a harbor worker to have them. A scene written off this canon will
not contradict anything the world already knows about Tessa.

**Anatomy: calm and precise.** Not hinted ("womanly curves"), not
euphemized ("her treasure"), and not pornographic in tone. Canon is
description — as level-headed as a description of clothing. Size,
color, sensitivity, particulars — concrete, without theater.

**The last paragraph is boundaries and conditions.** This is, in many
ways, the most important paragraph. It does not "manage risk"; it *is*
character. Tessa does not go to bed for a flirt. She goes there through
trust and her own decision. This paragraph is a direct instruction to
the narrator: do not try to bring her there by the short route — she
will not go. Without this paragraph, intimate scenes become flat and
cheap.

If your character is a companion, a romantic interest, or simply an
adult for whom intimacy with the hero is plausible by the logic of the
world, write this section **in advance**. Not "when it becomes
necessary" but **right alongside `Appearance`**. Then the world stays
coherent, and the intimate scene, when it happens, is an honest part of
the story rather than an awkward improvisation.

## What you have now

Tessa is a person now. She has a past, a voice, a desire, and a fear.
Her relationship with the hero will change because of actions, not
because of "correct dialogue answers." That is the Greenhaven effect:
the character remembers and responds.

The reference at the end of the chapter lists every section you can
add. You do not have to fill them all in at once. For a first character,
what we just walked through is enough.

## What's next

Tessa has a desire — to find out what happened to her brother. That
means she has a quest. Let's write it. Open
[Your first quest](Your%20first%20quest.md).

---

## Reference

**Required section**

- `## Identity`

**Minimum for a playable character**

- `## Role`
- `## Appearance`
- `## Voice`
- `## Want`
- `## Fear`
- `## Relationship Triggers`

**Additional**

- `## Routine` — daily routine
- `## Secret / Pressure` — secret and pressure point
- `## Relationship` — narrative of relationship with the hero
- `## Romance` — romantic arc
- `## Memory Hooks` — what the character will remember
- `## Skills` — skills and weaknesses
- `## Behavior` — behavior in combat, trade, intimacy
- `## Companion Rules` — companion contract (see
  [Companions](../03-mechanics/Companions.md))
- `## Merchant` — merchant offering (see
  [Economy](../03-mechanics/Economy.md))
- `## Inventory` — what they carry
- `## Materializes` — what appears in the world from their actions
- `## Appearance For Portrait` — brief for the art generator
- `## Sexual Appearance` — body in an intimate scene (adult content only)

**The full specification of every section** lives in the
[NPC reference](../02-reference/NPC%20reference.md).
