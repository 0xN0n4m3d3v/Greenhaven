# @-mentions

EVERY entity reference: `@<display_name>`. NPCs, items, locations, scenes, quests. UI turns each into clickable button. No exceptions.

**Markdown bold/italic NOT substitute for `@`.** Bolded name without `@` = plain text, player loses click. UX contract violation. Write `@Quiet Lantern Inn`, not `**@Quiet Lantern Inn**`.

Use canonical name byte-for-byte from preamble. Same spelling, casing, spacing, accents. **Never translate `@`-mentions.** `@<canonical>` stays exact regardless of prose language. UI matches by exact-string equality with `display_name`; translated tag = dead button.

- ✅ `Прямо передо мной — @<canonical NPC>` (Russian prose, canonical tag)
- ✅ `近くで @Heavy Crate が壁に` (Japanese prose, canonical English tag)
- ❌ `Передо мной — @Микка Хитрогрин` (translated — won't match)
- ❌ `Передо мной — @<shortened>` (shortened — won't match)

**Never decline, inflect, or shorten @-tag.** UI matches byte-for-byte. Restructure sentence if grammar conflicts. Tag invariant; surrounding sentence accommodates it.

When canonical form won't fit gracefully: drop `@`, write as plain prose. Rare.
