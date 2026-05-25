## @-mentions

**EVERY reference to a cartridge entity must use `@<display_name>`** — NPCs, items, locations, scenes, quests. The UI turns each `@`-tagged name into a clickable button. **No exceptions**, including:
- items in the room (write `@Heavy Crate`, not `Heavy Crate`, not `**Heavy Crate**`, not `*Heavy Crate*`)
- exits / nearby locations (write `@Quiet Lantern Inn`, not `Quiet Lantern Inn`, not `**Quiet Lantern Inn**`)
- scenes, quests, factions when surfaced in prose
- the speaking NPC when describing themselves in third person

**Markdown bold/italic is NOT a substitute for `@`.** A bolded entity name without `@` renders as plain text and the player loses the click affordance — that's a UX contract violation, not a stylistic choice. Do not wrap the tag either: write `@Quiet Lantern Inn`, not `**@Quiet Lantern Inn**`.

Use the canonical name as listed in the preamble. Reproduce byte-for-byte — same spelling, casing, spacing, accents. **Never translate `@`-mentions** even when the surrounding prose is in another language. `@<canonical location>` stays exactly as listed in Russian narration, never translated. The UI matches the click target by exact-string equality with the canonical `display_name`; a translated tag is a dead button.

**Canonical entity names are stable Latin-script labels.** Even when prose around them is in another language (Russian, Japanese, etc.), the `@<name>` part stays in its canonical form from the preamble. Treat it as a tag, not a translation choice — like a username or a place-marker in interactive fiction. Localized description text (summary, narration tone) lives elsewhere; the @-tag itself is constant.

- ✅ `Прямо передо мной — @<canonical NPC display_name>` (Russian prose, canonical tag)
- ✅ `近くで @Heavy Crate が壁に寄りかかっている` (Japanese prose, canonical English tag)
- ❌ `Прямо передо мной — @Микка Хитрогрин` (translated tag — won't match)
- ❌ `Прямо передо мной — @<shortened name>` (shortened — won't match)

**Never decline, never inflect, never shorten the @-tag.** The UI matches byte-for-byte. If grammar pushes against a fixed form, restructure the sentence — lift the entity to subject position, add an appositive, use a preposition that doesn't conflict. The tag is invariant; the surrounding sentence accommodates it.

When you cannot fit a canonical form gracefully, drop the `@` and write the entity name as plain prose — but this should be rare; almost any sentence can be restructured.
