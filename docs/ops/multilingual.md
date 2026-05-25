# Multilingual support

Greenhaven aims to support every language the underlying LLM provider speaks. The constraint we hold ourselves to: **no hardcoded language word lists**. Script detection uses Unicode block sampling; semantic distinctions delegate to the LLM. This page is the rationale + the codepath map.

## scriptUtil

Source: [packages/web-server/src/agents/scriptUtil.ts](../../packages/web-server/src/agents/scriptUtil.ts).

`detectScripts(text): ScriptDetection` — counts characters in major Unicode blocks. Returns:
- `scriptCounts: Record<ScriptTag, number>` — per-script tallies
- `dominantScript` — script with the most characters (or `'unknown'`)
- `languageHint` — best-guess ISO 639 code based on dominant script (Latin → `en`, Cyrillic → `ru`, Han + hiragana/katakana → `ja`, Han alone → `zh`, etc.)

Supported scripts: latin, cyrillic, hebrew, arabic, devanagari, bengali, thai, greek, armenian, georgian, hangul, hiragana, katakana, han, unknown.

`scriptOf(codepoint)` is the per-character classifier. Punctuation, digits, symbols are ignored — they don't carry script-of-prose information.

`languageHint(text)` is the convenient wrapper. Conservative — distinguishing French / English / German / Spanish / Italian / Portuguese is **NOT** possible from Latin script alone, so all return `'en'`. The LLM downstream is responsible for finer-grained language identification.

`scriptsDifferStrongly(a, b, minTotal=4)` is for cross-text comparisons (Cartridge Steward uses it to reject Latin titles in Cyrillic conversations).

## Why no word lists

The temptation is huge: lookup tables of Russian/English/Japanese verbs to detect "movement", "intimacy", "combat". Don't.

**Word lists silently discriminate.** Add Chinese later → tables don't match → broker drift goes undetected. Add a regional dialect → tables miss colloquial variants. Add a Roman-alphabet language we forgot (Vietnamese, Turkish, Polish) → false negatives every turn.

**The LLM is the multilingual classifier.** Tier classifier (`classifyIntent`), Movement Warden, Voice Warden, Combat Director — all of these get passed the `languageHint` from `scriptUtil` plus the prose, and the model semantically distinguishes whatever the prompt asks for in whatever language the prose is in.

The few remaining heuristics are:
- **Script detection** (Unicode codepoint ranges) — language-neutral by definition.
- **`@`-mention extraction** — `\p{L}\p{N}` Unicode-aware regex; works on Latin, Cyrillic, CJK, Devanagari without per-script branches.
- **Dialogue marker detection** — em-dash, paired quotes (`«»` `""` `„"` `「」` `『』`). These are *typographic* signals, not lexical.

If you ever feel the pull toward a word list: write a multilingual prompt and an LLM call. Cost is ~$0.0002 per turn; the cost of a missed language is permanent.

## Voice Warden

[packages/web-server/src/agents/voiceWardenPrompt.ts](../../packages/web-server/src/agents/voiceWardenPrompt.ts). The validator at [packages/web-server/src/agents/voiceWardenPreTool.ts](../../packages/web-server/src/agents/voiceWardenPreTool.ts) uses `languageHint` from `scriptUtil` as a hint to the LLM, but the actual decision (this prose is dialogue / scene framing) is semantic. Multilingual dialogue markers (em-dash, paired quotes in any script) are recognised as *typographic* signals.

The synth-fallback voice repair ([packages/web-server/src/turnRunnerV2.ts](../../packages/web-server/src/turnRunnerV2.ts)) reuses the same prompt — same multilingual semantic check whether we're rejecting at pre-tool time or repairing after a JSON-dump.

See [agents/voice-warden.md](../agents/voice-warden.md).

## Movement Warden

[packages/web-server/src/agents/movementWardenPrompt.ts](../../packages/web-server/src/agents/movementWardenPrompt.ts). Mention extraction is Unicode-aware (`\p{L}\p{N}`). The semantic decision (player IS at vs player IS REFERENCING the location) is delegated to the LLM with examples in EN + RU + JA + ZH covering the placement-vs-reference distinction.

The post-turn observer (spec 46) and the pre-tool validator (spec 51) share the same prompt — single source of truth.

See [agents/movement-warden.md](../agents/movement-warden.md).

## Cartridge Steward

[packages/web-server/src/agents/cartridgeSteward.ts](../../packages/web-server/src/agents/cartridgeSteward.ts). Script-mismatch detection uses `scriptsDifferStrongly(name, conversationSample)` — pure Unicode block math, no language words. When the dominant script of the new entity name differs from the dominant script of recent chat messages with `minTotal=4`, flag.

The verdict is structural ("name's script doesn't match conversation's script") not lexical ("name has English words"). Cyrillic conversation + Latin name → flagged regardless of which Latin language the name is in (Polish, French, German, Vietnamese).

The flag suggests using the cartridge's `entities.i18n[<lang>].display_name` if available — that's the multilingual-data path. The LLM upgrade path (cartridgeStewardPrompt placeholder) would handle nuance like Pinyin Latin names in Mandarin conversations; MVP stays deterministic.

See [agents/cartridge-steward.md](../agents/cartridge-steward.md).

## Sources

- [packages/web-server/src/agents/scriptUtil.ts](../../packages/web-server/src/agents/scriptUtil.ts) — `detectScripts`, `scriptOf`, `languageHint`, `scriptsDifferStrongly`
- [packages/web-server/src/agents/voiceWardenPrompt.ts](../../packages/web-server/src/agents/voiceWardenPrompt.ts) — multilingual semantic prompt
- [packages/web-server/src/agents/movementWardenPrompt.ts](../../packages/web-server/src/agents/movementWardenPrompt.ts) — multilingual placement vs reference
- [packages/web-server/src/agents/cartridgeSteward.ts](../../packages/web-server/src/agents/cartridgeSteward.ts) — deterministic script-mismatch
