# @The Cop Breaks

## Where And When

- Owner: `@Greenhaven Police Department`
- Location: `@Greenhaven Police Department`
- Visibility: triggers at the start of the SEVENTH loop (loop_count >= 7) when
  the hero wakes in the locker room. The weight of seven deaths has become
  unbearable. The hero's mind is fracturing.

## Hook

The fluorescent lights flicker — SEVEN times. You count them. You always count
them now.

The locker room is the same. The coffee smells the same. The case board has the
same seven empty slots. But when you look in the mirror above the sink, the
face staring back is not the face you remember. The eyes are wrong. Hollow.
Too deep in their sockets. The man in the mirror looks like he has died seven
times. And he has.

Your hand shakes as you reach for the combination lock. You know the
combination. You have always known the combination. But today — today your
fingers cannot find the numbers. They are the same numbers. They have always
been the same numbers. Why can you not open the locker?

@Detective Vex is at your side. You did not hear them approach. They are
saying something. Their mouth is moving but the words are not reaching you.
All you can hear is the flickering. The rain. The smell of bitter apples that
follows you out of every death and into every Monday.

You have died seven times. And something inside you has broken.

## Beat By Beat

1. The hero cannot open the locker. The combination is muscle memory — but
   muscles forget when the mind fractures. @Detective Vex gently takes the
   lock and opens it for you. They do not say anything. They have noticed.
   Everyone has noticed.
2. @Captain Harrow appears in the locker room doorway. He has been waiting
   for this. *"Detective. My office. Now."* Not a request. The internal
   investigation has been building. Today it lands.
3. In the office: Harrow lays out a file. *"You predicted the warehouse
   theft before it was reported. You knew the storage unit number before we
   had a warrant. You found evidence in four loops that forensics missed in
   one. You are either the greatest detective who ever lived, or you are
   involved in these crimes. I have spent seven weeks watching you. I have
   made my conclusion."*
4. The hero can: confess the truth (the time loop — Harrow will not believe
   it), resign (walk away from the case, let Voss win), or defy Harrow and
   continue the investigation off the books (the renegade path).
5. If the hero confesses: Harrow stares. Then he closes the file. *"Take a
   leave of absence, detective. Medical leave. Get help. I am not saying I
   believe you. I am saying you are no longer fit for duty."* The badge is
   revoked. The case is reassigned. The hero can still investigate — but
   without a badge, without department resources, without backup. The city
   is all that remains.
6. If the hero resigns: Harrow accepts. *"I will close the Voss case. He
   will be found. Eventually. Without you."* The hero walks out into the
   rain. The case board is wiped. Voss wins. Sunday comes. The gas disperses.
   And Monday — Monday comes again.
7. If the hero defies Harrow: *"Then you are no longer a detective in my
   department. Turn in your badge and your revolver. You want to chase a
   ghost? Do it as a civilian."* The hero is stripped of police authority.
   No badge. No revolver. No evidence locker. Just the notebook. Just the
   memory. Just the rain.

## Scene State

- `cop_breaking`: true — the hero's mind is fracturing under the weight of
  seven deaths.
- `badge_revoked`: true if the hero is suspended or fired. No police authority.
- `renegade_path`: true if the hero defies Harrow and continues without a
  badge.
- `resigned_path`: true if the hero walks away. Voss wins.

## Player Choices

- Confess the truth. Tell Harrow about the loop. He will not believe you —
  but it is the truth.
- Resign. Walk away. Let someone else carry the weight. Voss wins. But you
  survive.
- Defy Harrow. Continue the investigation. No badge. No backup. No revolver.
  Just the notebook and the rain and the million windows watching.
- Break down. Collapse. Let Vex call the paramedics. This is the end of the
  line — TRAPPED FOREVER ending triggers.

## Success Result

The hero survives the breakdown — barely. Whether suspended, resigned, or
renegade, the investigation continues in a diminished form. The loop still
resets upon death. The city still watches. But the hero is no longer whole.

## Failure Result

The hero collapses. @Trapped Forever triggers. The loop continues — but the
hero no longer participates consciously. The city digests another soul. The
case board stays empty. Voss wins. Sunday comes. Monday comes. Forever.

## Materializes

- When the hero is suspended:
  - Entity: `@Captain Harrow`
  - Type: state / hero suspended
  - Scope: `@Greenhaven Police Department`
  - Effect: badge and revolver confiscated. Evidence locker locked. No
    department resources. Investigation continues off the books.

- When the hero collapses (breakdown):
  - Entity: `@Trapped Forever`
  - Type: scene / very bad ending
  - Scope: `@Greenhaven City`
  - Effect: the hero's mind is lost. The loop continues without conscious
    participation. The city gains another permanent resident.

## Do Not Do Here

Do not make this scene heroic. It is a breakdown. The hero is not overcoming
adversity — the hero is being broken by it. Seven deaths is too many for
anyone. Let it hurt.

## Media Script

switch_music("music_loop_broken", label="The Cop Breaks", loop=false, volume=0.35)
