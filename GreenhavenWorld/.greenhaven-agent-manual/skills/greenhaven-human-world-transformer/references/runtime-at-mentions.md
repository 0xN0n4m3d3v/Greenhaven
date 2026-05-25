# Runtime At-Mentions

Greenhaven uses `@Name` as a live gameplay link, not only as Obsidian syntax.
The visible `@` is part of player-facing prose; the database entity name is not.

## Runtime Contract

- Store entity names without `@`: `display_name = "Mikka"`.
- Render links in prose with `@`: `@Mikka`.
- Keep proper names and `@` mentions byte-for-byte across translation.
- Treat `display_name` as the canonical mention key. Generated
  `i18n.display_name` values must either be omitted or repeat the exact base
  `display_name` in every language.
- Do not add localized aliases just because a language has a translated proper
  noun. Add aliases only when the human vault explicitly authors an alternate
  runtime mention that should be accepted.
- Do not generate two active entities whose runtime mention would be the same.

## Where Greenhaven Reads Mentions

- UI insertion uses `@${target.name}` from mention targets.
- UI rendering matches exact mention targets, longest trigger first, and may add
  a unique first-name shortcut.
- `narrate` uses `scanMentions()` over all active `display_name` and
  `profile.aliases`, then emits discovered mentions to the UI.
- dialogue participant ordering uses the exact matched `@${mention.name}`.
- Movement Warden and pre-tool guards inspect `@` location mentions to reject
  narration that moves the player without `move_player`.
- NPC Voice grounding rejects generated voice text that invents unsupported
  `@` mentions.

## Known Breakpoints

- Multi-word names break if a parser stops at whitespace. Generate tests for
  `@Town square`, `@The Docks`, and `@Thief's market`.
- Apostrophes can produce bad slugs if converted to a separator. Prefer
  `@Thief's market` -> slug `thiefs-market`.
- Runtime matching is exact for `display_name` and aliases. If the author writes
  `@Mikka` but the DB only has `Mikka Quickgrin`, add alias `Mikka`.
- `@` followed by generic prose can over-capture. Diff should warn when a
  mention candidate is not an exact generated display name or alias.
- Names differing only by case, punctuation, or leading articles are risky:
  `@Thief's market` vs `@Thiefs Market`, `@The Docks` vs `@Docks`.
- Empty `@` folders are placeholders, not playable mentions.
- Runtime prose in Russian must still write `@Thief's market`, not
  `@Рынок воров`; the surrounding sentence can be Russian.

## Import Validation

Before generating SQL/import:

1. Build a mention catalogue from generated `display_name` plus aliases.
2. Scan every human note for `@Name` mentions.
3. Resolve each mention exactly against the catalogue after stripping a leading
   `@` from folder names.
4. Report unresolved and ambiguous mentions in `unresolved-links.md`.
5. Ensure every player-facing hook that reveals a new entity uses the canonical
   runtime mention, e.g. `@Thief's market`.
6. Ensure generated i18n packs do not translate `display_name` or any `@Name`
   token in localized prose.
