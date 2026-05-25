# Creating the vault

Before you write your first scene, you need a place where the world will
live. This is no harder than creating a new folder for documents — but I
will walk you through every step so there is no "and now what do I click?"
left over.

## What you will need

A single program: **Obsidian**. It is a free notes editor. If you do not
have it, download it from `obsidian.md` and install it. On the surface it
looks like a text editor with a tree of folders on the left and text on
the right. That is all you need.

The word **vault** in Obsidian means "storage" — just one big folder that
the program treats as its project. Inside the vault are ordinary
subfolders and ordinary text files with the `.md` extension. There is
nothing magical, nothing hidden: if you open the vault in Windows
Explorer, you will see exactly the same files.

## Step 1. Create the vault

1. Open Obsidian.
2. On the start screen choose **Open folder as vault**.
3. Create a new empty folder — for example, `C:\MyWorld` — and select it.
4. Obsidian will create a hidden subfolder called `.obsidian` inside it.
   Do not touch it, do not open it, do not edit it. Those are its own
   settings. Treat it as invisible.

That is it. The folder `C:\MyWorld` is your world. You can even feel how
it sounds: *my world*.

## Step 2. Lay the framework

Every cartridge starts with a folder called `Locations`. Inside it the
structure is nested like a set of Russian dolls: first the city, then
districts within the city, then everything inside those districts. Let's
make it now.

The left-hand panel in Obsidian shows the files. Right-click on the empty
space, choose **New folder**, and name it exactly `Locations`. No `@` —
this is a service folder, not an entity.

Inside `Locations` create a folder for the city. *Here* the `@` goes on.
For the examples I will use a fictional city called `@Greenhaven City`,
but you can name yours anything you like: `@Old Highway`, `@Riverbend`,
whatever fits your world. The only rule is the at-sign in front.

```
MyWorld/
└── Locations/
    └── @Greenhaven City/
```

Inside the city live the districts. Each district is a place the player
can actually walk into. The square. The port. The guild. That is a
**location** in the strict sense, and each one has its own mind file.

Let's create the first district — the port:

```
MyWorld/
└── Locations/
    └── @Greenhaven City/
        └── @Greenhaven Port/
```

## Step 3. Give the location a voice

Each location has one main file. Its name follows a rule:
**the folder name minus the `@` and minus the spaces, plus the word
`Mind`, plus the `.md` extension.**

- Folder `@Greenhaven Port` → file `PortMind.md`.
- Folder `@Thief's Market` → file `Thief'sMarketMind.md` (spaces removed).
- Folder `@Main Square` → file `MainSquareMind.md`.

The rule is the same for every location. It exists so the engine can find
the "main mind" of a place without confusing it with other files in the
same folder.

Create the file `PortMind.md` inside `@Greenhaven Port/`. Open it and
write the bare minimum:

```markdown
# @Greenhaven Port

@Greenhaven Port is a sunlit harbor at the foot of @Greenhaven City.

## First Entry Bubble

You step off the gangway onto the warm planks of the port. The wind
smells of citrus crates and hot rope.
```

Let's break down what we just wrote.

- `# @Greenhaven Port` at the very top is a level-one heading (a single
  hash mark). It carries the location's name with the `@` in front. This
  is the file's "title page."
- After that comes an ordinary sentence describing the place.
- `## First Entry Bubble` is a level-two heading (two hash marks). This
  one is a service name: "the text the player sees the first time they
  enter this place." It is in English because that is the string the
  engine looks for. Under it you write the actual game prose — the line
  that will appear in the player's chat when they arrive.

`First Entry Bubble` is the most important section in any location. It
is the first impression. The next chapter goes into it in detail.

## Step 4. Settle the first resident here

Now we add a character. The folder for people is called exactly `npc` —
all lowercase, no `@`. It is a service name, the same kind as
`Locations`.

Inside `npc/` we create the character's folder, this time with the `@`:

```
@Greenhaven Port/
└── npc/
    └── @Tessa Wrenlight/
        └── NPCMind.md
```

`NPCMind.md` is the single file name for every character. Unlike
locations, you do not repeat the character's name in the file name. Every
character's "mind" is called the same thing.

Fill `NPCMind.md` with the minimum:

```markdown
# @Tessa Wrenlight

## Identity

I am @Tessa Wrenlight, a harbor scout. I watch the gangways and I know
every dockhand in this port by name.
```

Notice that the text under `## Identity` is written **in the first
person**. This matters. It is Tessa's own voice. She introduces herself.
Not "Tessa is a harbor scout" but "I am Tessa." That tunes the narrator
to her cadence from the very first line.

The next chapter, on characters, walks through the rest of the sections
that make Tessa actually live.

## What you have now

Open Windows Explorer and navigate to `C:\MyWorld`. You will see a tree
like this:

```
MyWorld/
└── Locations/
    └── @Greenhaven City/
        └── @Greenhaven Port/
            ├── PortMind.md
            └── npc/
                └── @Tessa Wrenlight/
                    └── NPCMind.md
```

This is enough for the engine to assemble your world. It will be tiny —
one port and one scout — but real.

## The one thing to remember

A folder name starts with `@` whenever it represents an **entity** in the
world: a location, a character, an item, a scene. Service folders
(`Locations`, `npc`, later `scenes`, `items`, `quests`) do **not** carry
an `@`. The rule is simpler than it sounds: ask "does this have a name of
its own?" If yes — `@`. If it is just "a box that holds other things" —
no `@`.

## What's next

Now that the vault exists and the skeleton of a place is sitting inside
it, let's make the port actually feel alive. Open
[Your first location](Your%20first%20location.md).

---

## Reference

**Minimum folder structure**

```
MyWorld/
└── Locations/
    └── @City/
        └── @Location/
            ├── <NameWithoutSpaces>Mind.md
            ├── npc/
            ├── items/
            ├── scenes/
            └── quests/
```

**Mind file names**

| Entity     | File name                                          |
| ---------- | -------------------------------------------------- |
| Location   | `<NameWithoutSpacesAndWithout@>Mind.md`            |
| Character  | `NPCMind.md`                                       |
| Item       | `ItemMind.md`                                      |
| Quest      | `Quest name.md` (spaces allowed, no `@`)           |
| Scene      | `@Scene name.md`                                   |

**Where `@` goes and where it doesn't**

- **With `@`:** names of locations, characters, items, scenes.
- **Without `@`:** service folders (`Locations`, `npc`, `items`, `scenes`,
  `quests`) and mind files (`PortMind.md`, `NPCMind.md`, etc.).
