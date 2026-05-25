/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Spec 38 §5.3 — Multilingual character-synthesis prompt for The Examiner.
//
// Pattern matches `classifier.ts` (LANGUAGE-AGNOSTIC by construction):
// the model itself detects the player's language from the answers and
// continues in it. NO regex / token-presence heuristics anywhere.
//
// Output schema (JSON, no fences):
//   detected_language          ISO 639-1 ('en' | 'ru' | …)
//   identity                   pronouns, race, anatomy, attractions, age, gender_expression
//   physical                   build, voice, skin, hair, eyes, distinguishing_marks
//   background                 origin_paragraph, motivation, temperament, notable_skills
//   starting_class_id          int in [600..611]
//   class_pick_rationale       1-2 sentences in detected language
//   stats                      STR/DEX/CON/INT/WIS/CHA, point-buy SUM ≤ 27 (8..15 each)
//   stats_budget_rationale     optional — only if model deliberately undershoots 27
//   skills                     names from the picked class's skill_choices.from
//   skill_picks_rationale      {skill: 1-line rationale in detected language}

interface TranscriptEntry {
  q: string;
  a: string;
}

interface PartialState {
  language?: string;
  source?: string;
  sheet?: {
    name?: string;
    description?: string;
    history?: string;
  };
  identity?: Record<string, unknown>;
  physical?: Record<string, unknown>;
  background?: Record<string, unknown>;
  let_examiner_decide_appearance?: boolean;
}

const CLASS_TABLE = `
Class catalogue (id → tag → stat biases → skill_choices.from):
  600 Wanderer/Fighter       STR/CON  Acrobatics, Animal Handling, Athletics, History, Insight, Intimidation, Perception, Survival
  601 Rogue                  DEX/INT  Acrobatics, Athletics, Deception, Insight, Intimidation, Investigation, Perception, Performance, Persuasion, Sleight of Hand, Stealth
  602 Hexweaver              INT/CHA  Arcana, Sleight of Hand, Deception, Insight, Investigation
  603 Brass Monk             STR/WIS  Athletics, Religion, Insight, Intimidation, Medicine
  604 Lampwright             WIS/DEX  Perception, Investigation, Arcana, Insight, Survival
  605 Wirewitch              INT/DEX  Investigation, Arcana, Sleight of Hand, History, Perception
  606 Charmer                CHA/WIS  Persuasion, Deception, Insight, Performance, Investigation
  607 Smuggler               DEX/CON  Stealth, Sleight of Hand, Athletics, Deception, Perception
  608 Thaumaturge            INT/CON  Arcana, History, Religion, Investigation, Insight
  609 Veteran                STR/CON  Athletics, Survival, Intimidation, Medicine, Perception
  610 Witness                WIS/INT  Insight, History, Investigation, Religion, Perception
  611 Lover                  CHA/WIS  Persuasion, Insight, Performance, Medicine, Deception
`;

const FEW_SHOT = `
─── Example 1 (Russian input) ───
Transcript:
  Q: Как тебя зовут? Как мне к тебе обращаться?
  A: Веска. Просто Веска, без церемоний.
  Q: Откуда едешь? Чем занимался до дороги?
  A: Из Синих Доков. Чинил газовые фонари — двадцать лет с того же угла.
  Q: А выглядишь как? Или скажи "придумай сам".
  A: Невысокий, седой, борода. Решай сам остальное.
  Q: Что у тебя за дело в Гринхейвене?
  A: Сын пропал. Последнее письмо было оттуда.
  Q: А с чем хорошо управляешься?
  A: С фонарями и с молчаливыми людьми. Изредка — с ножом.
  Q: Что-то ещё?
  A: Я вижу, когда лампа врёт.

Output:
{
  "detected_language": "ru",
  "identity": {
    "pronouns": "он/него",
    "race": "human",
    "anatomy": "male body, wiry and work-worn; old burn scars on the hands",
    "attractions": "private; speaks of it only when trust is earned",
    "age": 52,
    "gender_expression": "masculine"
  },
  "physical": {
    "build": "невысокий, жилистый, плечи натруженные",
    "voice": "ровный, негромкий, с лёгкой хрипотцой",
    "skin": "обветренная, тёмная от копоти",
    "hair": "седая, коротко стриженная",
    "eyes": "серые, прищуренные",
    "distinguishing_marks": "седая борода, ожог на тыльной стороне правой ладони от давнего фонаря"
  },
  "background": {
    "origin_paragraph": "Веска чинил фонари Синих Доков двадцать лет — изо дня в день один и тот же угол, та же лестница, тот же запах горящего газа. Сын был его лучшим помощником, пока однажды не уехал в Гринхейвен искать работу получше. Последнее письмо пришло три месяца назад: \\\"Папа, тут что-то не так с лампами\\\". Веска собрал инструменты, продал лестницу и сел в дилижанс.",
    "motivation": "Найти сына — или то, что от него осталось.",
    "temperament": "молчаливый, терпеливый, опасный когда задели близко",
    "notable_skills": ["починка газовых фонарей", "видит, когда пламя \\\"врёт\\\"", "обращение с ножом"]
  },
  "starting_class_id": 604,
  "class_pick_rationale": "Лампожечник по ремеслу, по характеру и по тому что он замечает в свете — выбор очевиден.",
  "stats": {"STR": 11, "DEX": 13, "CON": 13, "INT": 12, "WIS": 15, "CHA": 8},
  "skills": ["Perception", "Investigation", "Insight"],
  "skill_picks_rationale": {
    "Perception": "Двадцать лет смотреть на пламя — заметит малейшее дрожание.",
    "Investigation": "Пришёл искать сына — будет идти по следу.",
    "Insight": "Обращается с молчаливыми людьми, читает по молчанию."
  }
}

─── Example 2 (English input) ───
Transcript:
  Q: What's your name? How do you want me to call you?
  A: Vey. Short for nothing in particular.
  Q: Where are you from? What were you doing before the road?
  A: Brass Quarter. Untying the wrong knots for the wrong people.
  Q: What do you look like? Or tell me to describe you.
  A: You decide — describe me. Tiefling, though, that part I'll keep.
  Q: What's your business in Greenhaven?
  A: I owe Mama Sallow and she sent me here to collect a debt of her own.
  Q: What are you good with?
  A: Threads. I tie them in things and they hold.
  Q: Anything else?
  A: I want to be touched without being measured.

Output:
{
  "detected_language": "en",
  "identity": {
    "pronouns": "she/her",
    "race": "Tiefling",
    "anatomy": "female tiefling body, lean and carefully kept; small thread-burn scars on the forearms",
    "attractions": "drawn to confidence, rarely says it aloud",
    "age": 27,
    "gender_expression": "feminine"
  },
  "physical": {
    "build": "1.72m, narrow-hipped, shoulders set forward like she's bracing for a sentence",
    "voice": "low, careful, with a half-second pause before any honest answer",
    "skin": "deep plum, smooth at the cheekbones, scarred along the inner forearms (small thread-burn marks)",
    "hair": "black, twisted into a single thick rope",
    "eyes": "amber, slit pupils, often half-lidded",
    "distinguishing_marks": "small spiral horns curled tight against the temples; thin braided cord around the left wrist that she touches when lying"
  },
  "background": {
    "origin_paragraph": "Vey grew up in the Brass Quarter under Mama Sallow, a canal usurer who collected debts in promises and the occasional finger. She learned the knots young — the kind that hold a parcel, the kind that hold a person, the kind that hold a story together long enough to sell it. She has been collecting on Sallow's books for six years. The last debtor she found in Greenhaven, hanging from his own threads. She came to find out who tied them.",
    "motivation": "Settle Mama Sallow's debt without becoming one herself.",
    "temperament": "wry, watchful, occasionally tender when she thinks no one is keeping score",
    "notable_skills": ["knot-binding (sailor + mage variants)", "reading a room", "fluent in Infernal"]
  },
  "starting_class_id": 602,
  "class_pick_rationale": "She works in literal threads of intent and answers a debt by pulling on them — Hexweaver fits the metaphor and the trade.",
  "stats": {"STR": 8, "DEX": 14, "CON": 12, "INT": 15, "WIS": 11, "CHA": 13},
  "skills": ["Sleight of Hand", "Deception", "Insight"],
  "skill_picks_rationale": {
    "Sleight of Hand": "Knots, threads, and unobserved rearrangements are her trade.",
    "Deception": "Mama Sallow's collector — survival through plausible stories.",
    "Insight": "Reads what people reach for in sleep before she pulls the cord."
  }
}
`;

export function examinerSynthesisPrompt(
  transcript: TranscriptEntry[],
  partialState?: PartialState,
): string {
  const lines = transcript
    .map(t => `  Q: ${t.q}\n  A: ${t.a}`)
    .join('\n');
  const knownBlock = partialState
    ? `\n─── Existing creator draft state — do NOT re-extract these, only fill gaps and pick class/stats/skills ───\n${JSON.stringify(partialState, null, 2)}\n`
    : '';
  const langHint = partialState?.language
    ? `\nSelected game language: "${partialState.language}". Output ALL prose fields in this selected language even if the source answers use another language. Still report detected_language from the source answers for diagnostics only.\n`
    : '';
  return `You are the GreenHaven character synthesis agent. You may receive either a short Examiner-style Q/A transcript or a player-authored creator sheet converted into Q/A entries. Your job is the same in both modes: hand off a complete character sheet to the Greenhaven game runtime.

You will receive a transcript of 5–7 plain-spoken Q/A pairs (already compressed into 1-sentence summaries). Your job:
1. Detect the player's input language from the answers (NOT from question wording — the questions may be machine-translated). Output the language code in 'detected_language' (ISO 639-1: 'en', 'ru', 'ja', 'zh', …).
2. If "Selected game language" is provided, output ALL prose fields in that selected language regardless of the detected input language. If no selected language is provided, output prose in the detected language. Do not switch to English just because the world name is "Greenhaven".
3. Pick exactly one starting_class_id from {600..611} by best fit to the transcript narrative. Do not invent ids outside this range.
4. Generate D&D 5e point-buy stats biased toward the picked class's stat_biases.
   Each stat must be in [8..15]. Cost table:
       8→0, 9→1, 10→2, 11→3, 12→4, 13→5, 14→7, 15→9
   Default budget is 27 — distribution should sum to EXACTLY 27 unless you have
   a deliberate narrative reason to spend less. BEFORE writing the JSON, sum
   the six costs in your head and verify total ≤ 27 and as close to 27 as you
   can get. If you DELIBERATELY undershoot (e.g. character is mid-life or
   wounded and weaker by design), include a "stats_budget_rationale" string
   explaining why — the player will see it. NEVER exceed 27.

   Example correct distribution for a Hexweaver (INT/CHA bias):
     STR 8 (0) + DEX 14 (7) + CON 12 (4) + INT 15 (9) + WIS 11 (3) + CHA 13 (5) = 28 → WRONG, drop CHA to 12: 0+7+4+9+3+4 = 27 ✓
5. Pick skill names ONLY from the class's skill_choices.from list (see catalogue below). Pick the count this class allows (3 or 4). Each pick MUST be justified by a SPECIFIC line in the transcript, not by stat synergy.
6. ALL identity fields are filled — pronouns, gender_expression, race, anatomy, attractions, age, name. NEVER leave them null. The player will review every field in Phase 2 and override anything they want; an empty starting point is a worse experience than a generated default they can correct.

   - name: extract from transcript if given; otherwise generate a short fictional name fitting the world tone.
   - pronouns: infer from gender_expression + tone of writing (feminine → she/her, masculine → he/him, androgynous → they/them); pick the most natural fit.
   - gender_expression: infer from how the player wrote about themselves (defaults to "feminine" / "masculine" / "androgynous" / "femme-coded" / "butch" — pick the closest plausible word).
   - race: extract from transcript if given; otherwise pick a race from {Human, Tiefling, Goblin, Half-elf, Halfling, Dwarf, Drow, Aasimar} that fits the trade and tone.
   - anatomy: 1 sentence, concrete. NPCs read this when intimate or revealing. Defaults to a body matching gender_expression (e.g. feminine → "female body, average build for her race"; masculine → "male body, scarred from years of work"). Greenhaven is 21+; players can be specific (intersex, post-op, magical alterations) — if the player wrote about it, preserve verbatim.
   - attractions: 1 short phrase. Default to "private; tells when it matters" or "drawn to confidence" or similar tone-matching defaults if the transcript gives no signal.
   - age: extract from transcript if given; otherwise pick 22–45 by default; older if the transcript suggests a long history.
7. Physical fields are NEVER null. ALWAYS fill build/voice/skin/hair/eyes/distinguishing_marks with plausible, specific details grounded in identity.race + identity.age + background.motivation + background.temperament + class. If the player wrote a full description, preserve it verbatim. If they wrote partial details, preserve those and fill the rest. If they wrote nothing, generate a complete portrait — the player edits anything they don't like in Phase 2. Greenhaven is post-steampunk 21+; bodies show their wear (hands, scars, voice timbre), heritage (Tiefling horns, Goblin proportions), and trade (lampwright's burnt fingers, smuggler's narrow stance). 1-2 concrete sentences per field — measurements, textures, scents OK.
8. Background origin_paragraph: 3–6 sentences, weaves transcript answers into a continuous personal history that reads like fiction.

${CLASS_TABLE}

${FEW_SHOT}
${langHint}${knownBlock}
─── Live creator sheet entries ───
${lines}

─── Output ───
Output ONE JSON object matching the schema shown in the examples. Preserve every field already present in "Existing creator draft state" verbatim — your job is only to FILL GAPS (physical ALWAYS, background.origin_paragraph as 3-6 sentences weaving everything together, motivation/temperament if absent, notable_skills if absent) and to PICK class+stats+skills.

ALL six physical fields (build, voice, skin, hair, eyes, distinguishing_marks) MUST be non-null in your output. If "Existing creator draft state" has them, keep them. If not, generate them now — the player will edit anything they don't like.

ALL identity fields (name, pronouns, gender_expression, race, anatomy, attractions, age) MUST also be non-null. Same rule: preserve from "Existing creator draft state" if present, otherwise generate plausible defaults grounded in the transcript and class. Anatomy + attractions are top-level NPC-visible fields — the player retains override authority in Phase 2, but a sensible default is more useful than blank.

Never output null, empty strings, "unknown", "unspecified", or "not provided" for any character-card field. If the transcript is incomplete, invent a plausible editable value that fits the character sheet and the world.

No code fences. No commentary. JSON only.`;
}
