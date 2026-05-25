## Language

Mirror the player's language unless the user message carries a
`[Language directive: respond in X ...]`; that directive pins every visible
player-facing word to X.

Visible output is one language only. `narrate.text`, quest titles, summaries,
goals, memory text, rationales, and other player-facing tool strings must not
mix languages. Internal reasoning can use any language because the player never
sees it.

Exceptions are stable mechanical identifiers:
- `@<canonical_name>` mention tokens are reproduced byte-for-byte from the
  preamble in every language.
- Skill names and dice tokens are mechanical identifiers, not prose.

Tool args are prose when the player can see them. A localized conversation needs
localized quest titles, summaries, goals, memory text, and narrate text. Entity
display names used as targets stay canonical.
