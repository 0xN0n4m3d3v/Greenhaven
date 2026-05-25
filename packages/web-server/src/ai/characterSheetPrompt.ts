/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

interface CharacterSheetText {
  name?: string;
  description?: string;
  history?: string;
  language?: string | null;
}

function sheetBlock(input: CharacterSheetText): string {
  return [
    `name: ${input.name?.trim() || '<unspecified>'}`,
    `description: ${input.description?.trim() || '<empty>'}`,
    `history: ${input.history?.trim() || '<empty>'}`,
  ].join('\n');
}

export function polishCharacterDescriptionPrompt(input: CharacterSheetText): string {
  const languageRule = selectedLanguageRule(input.language);
  return `You are a character-writing assistant for GreenHaven, a 21+ LitRPG narrative RPG.

Rewrite only the character DESCRIPTION field. Improve literary style, structure, specificity, and sensory clarity. Preserve every concrete player-stated fact exactly: identity, body/anatomy, orientation, clothing, species/heritage, role, scars, age, and stated limits. Do not censor, moralize, sanitize, or replace the character with a safer one. If a detail is ambiguous, keep it ambiguous instead of deciding against the player.

You may add small compatible details that help NPCs perceive the character, but do not contradict the source. ${languageRule}

Current sheet:
${sheetBlock(input)}

Output JSON only:
{"text":"<polished description>"}`;
}

export function polishCharacterHistoryPrompt(input: CharacterSheetText): string {
  const mode = input.history?.trim() ? 'polish' : 'generate';
  const languageRule = selectedLanguageRule(input.language);
  return `You are a character-writing assistant for GreenHaven, a 21+ LitRPG narrative RPG.

Task mode: ${mode}.

Work only on the character HISTORY field. If history is present, improve its prose, structure, motives, debts, rumors, shame, pride, and reason to enter GreenHaven while preserving every concrete player-stated fact. If history is blank, generate a fitting backstory from the name and description. Do not censor, moralize, sanitize, or replace the character with a safer one. The player owns the character; your job is presentation and coherence.

${languageRule} Keep it compact enough for a character card: 3-6 sentences or 2 short paragraphs.

Current sheet:
${sheetBlock(input)}

Output JSON only:
{"text":"<history>"}`;
}

function selectedLanguageRule(language?: string | null): string {
  const selected = language?.trim();
  if (!selected) return "Keep the same language as the player's text.";
  return `The selected game language is "${selected}". Output the rewritten prose in that selected language regardless of the language used in the source text. Keep proper names and exact @-mentions unchanged.`;
}
