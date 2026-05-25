# @The Hobo Counts

## Where And When

- Owner: `@The Hobo`
- Location: `@Greenhaven City`
- Visibility: triggers after the hero dies and the loop resets — @The Hobo is
  waiting somewhere in the city, and the hero will stumble upon the figure
  sooner or later. The figure always knows when the count has changed.

## Hook

You find the figure where you always find it — or where it always finds you. A
back alley. A trash-can fire burning without fuel. The overturned crate. The
hooded shape, motionless, grey hands resting on its knees.

But this time, the figure looks up as you approach. The hood tilts — not a
greeting, but an acknowledgment. And then it speaks. The voice scrapes out of
the shadow beneath the hood like a manhole cover dragged across asphalt:

*"That was your third time."*

Or your fifth. Or your twelfth. The number changes. The figure does not.

It knows exactly how many times you have died. It has been counting since the
first Monday.

## Beat By Beat

1. The figure names the number — simply, without drama. A fact. Like stating
   the time, or the temperature of the rain. *"That was your seventh death."*
   The number hangs in the air between you. The fire crackles. The rain
   continues.
2. If the loop count is low (1-3): the figure adds a single observation. *"You
   are learning. The city notices."* If the count is medium (4-10): *"You have
   died enough to understand. The question is whether you will die enough to
   win."* If the count is high (10+): the figure pauses longer than usual. Then,
   very quietly: *"I have never seen anyone die this many times and keep
   standing. The city is... interested."*
3. The figure does not offer comfort. The count is not a condemnation and not a
   pep talk. It is data. The figure is a ledger, and the hero's deaths are
   entries. But the way the grey hands rest — open, not clenched — suggests
   something that is not quite compassion but wears the same shape.
4. The figure falls silent. The counting is done — until the next death. The
   fire burns. The rain falls. The crate still has an empty space beside the
   figure, as it always does.
5. If the hero asks how many deaths are too many: the figure does not answer
   with a number. Instead: *"The loop does not have a limit. Only a condition.
   Seven cases. Seven days. Sunday night. The count stops when you stop
   dying."*

## Player Choices

- Sit beside the figure. Share the silence after the number. The count is
  heavy — the crate helps.
- Ask the figure how many other people have been trapped in the loop. The
  figure's hood tilts differently — a hesitation. Then: *"Enough that I
  learned to count."* No further answer.
- Ask what happens if the hero gives up — stops trying, lets the loop run
  without solving cases. The figure's voice drops: *"The city digests you
  slowly. You become like the other detectives in the department — hazy,
  repeating, not quite real. I would still count you. But you would not hear
  me anymore."*
- Accept the number. Stand up. Return to the week. The figure respects this
  most of all.
- Ask @The Hobo to keep counting. The figure does not answer — because it was
  already going to. The counting is not a favour. It is a function.

## Scene State

- `hobo_counted_loop`: the loop number the figure just named.
- `hero_heard_count`: true if the hero stayed to hear the number.
- `hero_asked_about_others`: true if the hero asked about previous victims of
  the loop.
- `count_conversations`: increments each time this scene triggers — the
  running tally of how many times the hero has discussed the count with the
  figure.

## Success Result

The hero knows the number. The figure has counted. The loop is quantified —
which does not make it easier, but makes it real. The hero is not imagining the
repetition. The number proves it.

## Failure Result

If the hero walks away before the figure names the number, the number is still
counted — but the hero does not hear it. The figure will not repeat it until
the next death. The hero must wait through another full loop to learn the new
count.

## Memory And String Changes

`@The Hobo` records: the loop count at the time of this conversation, the
hero's reaction to the number, whether the hero asked about others. The figure
remembers every count conversation — and may reference previous numbers in
future visits.

## Do Not Do Here

Do not let the figure's tone become pitying. The count is neutral. The figure
is a ledger, not a therapist. Do not let the figure predict how many more loops
it will take. The figure does not know the future — it only counts the past. Do
not let the hero argue with the number. The number is objective truth. The hero
can accept it or walk away — but cannot change it.

## Scene Image Brief

Image target: `images/the-hobo-counts.png` (1:1). The hooded figure seated on
an overturned crate beside a trash-can fire. The figure's grey hand is raised —
fingers extended, counting. Three fingers visible. The other hand rests palm-up
on the figure's knee. The firelight catches the extended fingers. The figure's
face is — as always — entirely lost in the shadow of the deep hood. Behind: wet
brick alley, rain, steam. The gesture of counting is the focal point. Style:
intimate noir chiaroscuro, warm firelight on grey skin, cold rain beyond. Square
1:1, 2048x2048. No text, no face.

## Media Script

show_media("media_the_hobo_counts", title="The Hobo Counts", caption="Grey fingers extended. One. Two. Three. Each digit a death. Each knuckle a Monday morning.")
switch_music("music_the_hobo_counts", label="The Hobo Counts — The Ledger of Deaths", loop=false, volume=0.42)
