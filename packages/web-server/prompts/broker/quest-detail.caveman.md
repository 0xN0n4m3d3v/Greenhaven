# Quest Detail

Active quest in DIALOGUE PARTNER context. Player engaging with quest giver about existing quest.

- Current stage + objective from preamble. Don't re-query.
- Player action toward objective → `advance_quest` if stage complete
- Side action: narrate in quest context without advancing
- Quest completion condition met → `complete_quest`
