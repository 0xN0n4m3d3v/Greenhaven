# @The Hobo Offers

## Where And When

- Owner: `@The Hobo`
- Location: `@Greenhaven City`
- Visibility: triggers when the hero has witnessed at least three city
  monologues and has sat beside the figure at least once. The city has decided
  the hero needs something — and the figure is how the city delivers.

## Hook

You are sitting beside the figure again. The trash-can fire burns its steady,
consuming-nothing flame. The rain traces its patient patterns on the brick
walls. You have done this before — the silence, the stillness, the wordless
company. It has become something you recognise.

This time, the figure moves differently. Slowly — with the deliberation of a
ritual — it reaches into the layers of its coat. The grey fingers search for a
moment, then close around something. When the hand emerges, it is holding an
object. Small. Wrapped in a scrap of dry cloth — dry, despite the eternal rain.

The figure places it on the crate between you. The gesture says: this is yours.
Not a gift. Not a reward. A tool. The city has been watching, and the city has
decided: you need this now.

## Beat By Beat

1. The figure places the object on the crate. It does not push it toward the
   hero — just places it in the space between them, equidistant. The choice to
   take it belongs entirely to the hero.
2. If the hero examines the object without taking it: the figure waits. No
   impatience. The fire continues to burn. The rain continues to fall. The
   object sits on the crate, dry and patient.
3. If the hero takes the object: the figure nods once — the smallest
   acknowledgment. Then returns to stillness. The transaction is complete.
4. If the hero asks what it is or why: the figure MIGHT speak one sentence. Not
   an explanation — a context. *"The city thinks you need it."* Or: *"I was
   told to give you this."* Or, very rarely: *"You will know when to use it."*
5. The figure does not ask for anything in return. Does not expect gratitude.
   The object is given because the city decided. The figure is only the hands
   that deliver.

## Player Choices

- Take the object. Examine it. Keep it.
- Leave it on the crate. The figure will not take it back. It will remain there
  — waiting — for the next visit. Or the next. The city is patient.
- Ask the figure why. The answer, if it comes, will be sparse — but true.
- Refuse the object and walk away. The figure does not react. But the next time
  the hero truly needs something, the crate will be empty.

## Scene State

- `hobo_offered_gift`: the name of the object offered.
- `hero_accepted_gift`: true if the hero took the object.
- `gift_refused_count`: increments if the hero refuses — the city offers fewer
  things to those who refuse its gifts.

## Success Result

The hero has received something the city believes they need. The object enters
the hero's inventory. It is never a weapon. It is never currency. It is a key,
a clue, a token, a dry matchbox, a compass that points to something the hero
has not yet found, a photograph of a window that looks like the hero's window.

## Failure Result

If the hero refuses the object three times, the figure stops offering. It will
still sit. Still witness. Still pull the hero up when they fall. But the era of
gifts is over. The city has decided: this one does not accept help that is not
asked for.

## Memory And String Changes

`@The Hobo` records every object given and whether it was accepted. Some objects
are unique — given only once. The figure knows what it has already offered.

## Materializes

- When the hero accepts the object:
  - Entity: the offered item (runtime — depends on what the city decides)
  - Type: item / city gift
  - Scope: hero inventory
  - Effect: the hero receives the item the figure placed on the crate.

## Media Script

show_media("media_the_hobo_offers", title="The Hobo Offers", caption="A cloth-wrapped object placed on the crate. The city has decided you need this.")
switch_music("music_the_hobo", label="The Hobo Offers", loop=true, volume=0.38)

## Do Not Do Here

Do not let the object be something the hero explicitly asked for. The city
decides. The hero receives. Do not make the object powerful — no weapons, no
magic artifacts, no solutions. These are tools for the journey: a key, a clue,
a comfort. Do not let the figure explain the object's full significance. The
hero must discover it.

## Scene Image Brief

Image target: `images/the-hobo-offers.png` (1:1). Close-up on the space between
two figures sitting on a crate. On the left edge of frame: the knee of the hero
(just fabric, no face). On the right edge: the grey, long-fingered hand of the
hooded figure, palm up, holding a small cloth-wrapped object. Between them: the
crate's wooden surface, a trash-can fire burning in the background, rain
falling. The object in the hand is partially unwrapped — just enough to see it
is something significant, but not enough to identify it fully. Style: intimate
noir still life, warm firelight on the hands, cold rain in the background.
Square 1:1, 2048x2048. No faces. No text.
