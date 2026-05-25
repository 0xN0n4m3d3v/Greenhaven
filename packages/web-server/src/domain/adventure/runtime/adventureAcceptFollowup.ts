/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {normalizeAgentLanguageCode} from '../../../agents/agentLanguageContract.js';
import {query} from '../../../db.js';
import {
  SUPPORTED_LANGUAGE_CODES,
  SUPPORTED_LANGUAGE_SET,
  type SupportedLanguageCode,
} from '../../../languages.js';
import {
  parseAdventureBlueprint,
  type AdventureBlueprint,
} from './adventureBlueprint.js';
import type {AdventureQueueRow} from './adventureQueue.js';

interface AdventureAcceptTemplate {
  intro: string;
  goalLabel: string;
  firstStepLabel: string;
  returnLine: string;
}

const ACCEPT_FOLLOWUP_TEMPLATES: Record<
  SupportedLanguageCode,
  AdventureAcceptTemplate
> = {
  ar: {
    intro: 'حسنا. هذه هي التفاصيل.',
    goalLabel: 'المهمة:',
    firstStepLabel: 'الخطوة الأولى:',
    returnLine: 'عد عندما يكون لديك شيء ملموس.',
  },
  bn: {
    intro: 'ঠিক আছে। বিস্তারিত বলছি।',
    goalLabel: 'কাজ:',
    firstStepLabel: 'প্রথম ধাপ:',
    returnLine: 'কিছু নিশ্চিত পেলে ফিরে এসো।',
  },
  bg: {
    intro: 'Добре. Ето подробностите.',
    goalLabel: 'Задача:',
    firstStepLabel: 'Първа стъпка:',
    returnLine: 'Върни се, когато имаш нещо конкретно.',
  },
  de: {
    intro: 'Gut. Hier sind die Einzelheiten.',
    goalLabel: 'Aufgabe:',
    firstStepLabel: 'Erster Schritt:',
    returnLine: 'Komm zurück, wenn du etwas Handfestes hast.',
  },
  el: {
    intro: 'Εντάξει. Αυτές είναι οι λεπτομέρειες.',
    goalLabel: 'Αποστολή:',
    firstStepLabel: 'Πρώτο βήμα:',
    returnLine: 'Γύρνα όταν έχεις κάτι συγκεκριμένο.',
  },
  en: {
    intro: 'All right. Here are the details.',
    goalLabel: 'Task:',
    firstStepLabel: 'First step:',
    returnLine: 'Come back when you have something concrete.',
  },
  es: {
    intro: 'Bien. Estos son los detalles.',
    goalLabel: 'Tarea:',
    firstStepLabel: 'Primer paso:',
    returnLine: 'Vuelve cuando tengas algo concreto.',
  },
  fa: {
    intro: 'بسیار خوب. جزئیات این است.',
    goalLabel: 'وظیفه:',
    firstStepLabel: 'گام اول:',
    returnLine: 'وقتی چیز مشخصی داشتی برگرد.',
  },
  fr: {
    intro: 'Très bien. Voici les détails.',
    goalLabel: 'Tâche :',
    firstStepLabel: 'Première étape :',
    returnLine: 'Reviens quand tu auras quelque chose de concret.',
  },
  he: {
    intro: 'בסדר. אלה הפרטים.',
    goalLabel: 'משימה:',
    firstStepLabel: 'צעד ראשון:',
    returnLine: 'חזור כשיהיה לך משהו ממשי.',
  },
  hi: {
    intro: 'ठीक है। ये विवरण हैं।',
    goalLabel: 'काम:',
    firstStepLabel: 'पहला कदम:',
    returnLine: 'जब कुछ ठोस मिले तो वापस आना।',
  },
  hy: {
    intro: 'Լավ։ Ահա մանրամասները։',
    goalLabel: 'Առաջադրանք՝',
    firstStepLabel: 'Առաջին քայլ՝',
    returnLine: 'Վերադարձիր, երբ կոնկրետ բան ունենաս։',
  },
  it: {
    intro: 'Va bene. Ecco i dettagli.',
    goalLabel: 'Compito:',
    firstStepLabel: 'Primo passo:',
    returnLine: 'Torna quando avrai qualcosa di concreto.',
  },
  ja: {
    intro: 'よし。詳しい話をしよう。',
    goalLabel: '任務:',
    firstStepLabel: '最初の手順:',
    returnLine: '確かなものをつかんだら戻ってきてくれ。',
  },
  ka: {
    intro: 'კარგი. აი დეტალები.',
    goalLabel: 'დავალება:',
    firstStepLabel: 'პირველი ნაბიჯი:',
    returnLine: 'დაბრუნდი, როცა ხელშესახები რამე გექნება.',
  },
  ko: {
    intro: '좋아. 자세히 말해 줄게.',
    goalLabel: '임무:',
    firstStepLabel: '첫 단계:',
    returnLine: '확실한 것을 얻으면 돌아와.',
  },
  mr: {
    intro: 'ठीक आहे. तपशील असे आहेत.',
    goalLabel: 'काम:',
    firstStepLabel: 'पहिले पाऊल:',
    returnLine: 'काही ठोस मिळाले की परत ये.',
  },
  ne: {
    intro: 'ठीक छ। विवरण यस्ता छन्।',
    goalLabel: 'काम:',
    firstStepLabel: 'पहिलो कदम:',
    returnLine: 'केही ठोस पाएपछि फर्क।',
  },
  pt: {
    intro: 'Certo. Estes são os detalhes.',
    goalLabel: 'Tarefa:',
    firstStepLabel: 'Primeiro passo:',
    returnLine: 'Volte quando tiver algo concreto.',
  },
  ro: {
    intro: 'Bine. Iată detaliile.',
    goalLabel: 'Sarcină:',
    firstStepLabel: 'Primul pas:',
    returnLine: 'Întoarce-te când ai ceva concret.',
  },
  ru: {
    intro: 'Хорошо. Вот детали.',
    goalLabel: 'Задача:',
    firstStepLabel: 'Первый шаг:',
    returnLine: 'Вернись, когда будет что-то конкретное.',
  },
  sr: {
    intro: 'Добро. Ево детаља.',
    goalLabel: 'Задатак:',
    firstStepLabel: 'Први корак:',
    returnLine: 'Врати се када будеш имао нешто конкретно.',
  },
  th: {
    intro: 'ตกลง นี่คือรายละเอียด',
    goalLabel: 'ภารกิจ:',
    firstStepLabel: 'ขั้นแรก:',
    returnLine: 'กลับมาเมื่อมีอะไรที่ชัดเจนแล้ว',
  },
  uk: {
    intro: 'Добре. Ось подробиці.',
    goalLabel: 'Завдання:',
    firstStepLabel: 'Перший крок:',
    returnLine: 'Повертайся, коли матимеш щось конкретне.',
  },
  ur: {
    intro: 'ٹھیک ہے۔ تفصیل یہ ہے۔',
    goalLabel: 'کام:',
    firstStepLabel: 'پہلا قدم:',
    returnLine: 'جب کوئی ٹھوس بات ملے تو واپس آنا۔',
  },
  zh: {
    intro: '好。细节如下。',
    goalLabel: '任务:',
    firstStepLabel: '第一步:',
    returnLine: '有了确切线索就回来。',
  },
};

export interface AdventureAcceptFollowup {
  turnId: string;
  text: string;
  authorId: number | null;
  language: SupportedLanguageCode;
}

export function validateAdventureAcceptFollowupTemplates(): {
  checkedCount: number;
  languages: readonly SupportedLanguageCode[];
} {
  const english = ACCEPT_FOLLOWUP_TEMPLATES.en;
  let checkedCount = 0;
  for (const language of SUPPORTED_LANGUAGE_CODES) {
    const template = ACCEPT_FOLLOWUP_TEMPLATES[language];
    for (const [key, value] of Object.entries(template)) {
      if (!value.trim()) {
        throw new Error(`${language}.${key} is empty`);
      }
      if (containsMojibakeMarker(value)) {
        throw new Error(`${language}.${key} contains mojibake markers: ${value}`);
      }
      checkedCount += 1;
    }
    if (language !== 'en' && template.intro === english.intro) {
      throw new Error(`${language}.intro fell back to English`);
    }
  }
  return {checkedCount, languages: SUPPORTED_LANGUAGE_CODES};
}

export async function buildAdventureAcceptFollowup(opts: {
  row: AdventureQueueRow;
  playerId: number;
}): Promise<AdventureAcceptFollowup | null> {
  const blueprint = parseBlueprint(opts.row.blueprint);
  if (!blueprint) return null;
  const title = cleanText(blueprint.suggestedQuest?.title ?? blueprint.title);
  const summary = cleanText(
    blueprint.suggestedQuest?.summary ??
      blueprint.summary ??
      blueprint.playerFacingHook,
  );
  const goal = cleanText(blueprint.suggestedQuest?.goal_text);
  const firstStep = cleanText(blueprint.suggestedQuest?.stages?.[0]?.title);
  if (!summary && !goal && !firstStep) return null;

  const language = await resolveFollowupLanguage(opts.row, opts.playerId);
  const template = ACCEPT_FOLLOWUP_TEMPLATES[language];
  const text = renderFollowupText({
    template,
    title,
    summary,
    goal,
    firstStep,
  });
  if (!text.trim()) return null;

  return {
    turnId: `adventure-accept:${opts.row.id}:details`,
    text,
    authorId: await resolveQuestGiverAuthorId(blueprint),
    language,
  };
}

function parseBlueprint(input: Record<string, unknown> | null): AdventureBlueprint | null {
  const parsed = parseAdventureBlueprint(input);
  return parsed.ok ? parsed.blueprint : null;
}

async function resolveFollowupLanguage(
  row: AdventureQueueRow,
  playerId: number,
): Promise<SupportedLanguageCode> {
  const fromContext = toSupportedLanguage(row.contextSnapshot['language']);
  if (fromContext) return fromContext;
  const player = await query<{preferred_language: string | null}>(
    `SELECT preferred_language FROM players WHERE entity_id = $1`,
    [playerId],
  ).catch(() => ({rows: [] as Array<{preferred_language: string | null}>}));
  return toSupportedLanguage(player.rows[0]?.preferred_language) ?? 'en';
}

async function resolveQuestGiverAuthorId(
  blueprint: AdventureBlueprint,
): Promise<number | null> {
  const rawId =
    blueprint.suggestedQuest?.giverEntityId ??
    blueprint.suggestedQuest?.sourceEntityId ??
    null;
  if (typeof rawId !== 'number' || !Number.isInteger(rawId) || rawId <= 0) {
    return null;
  }
  const entity = await query<{kind: string}>(
    `SELECT kind FROM entities WHERE id = $1`,
    [rawId],
  );
  return entity.rows[0]?.kind === 'person' ? rawId : null;
}

function toSupportedLanguage(input: unknown): SupportedLanguageCode | null {
  if (typeof input !== 'string') return null;
  const normalized = normalizeAgentLanguageCode(input);
  return SUPPORTED_LANGUAGE_SET.has(normalized)
    ? (normalized as SupportedLanguageCode)
    : null;
}

function renderFollowupText(opts: {
  template: AdventureAcceptTemplate;
  title: string;
  summary: string;
  goal: string;
  firstStep: string;
}): string {
  const lines = [
    opts.template.intro,
    opts.title ? `«${opts.title}»` : null,
    opts.summary,
    opts.goal ? `${opts.template.goalLabel} ${opts.goal}` : null,
    opts.firstStep ? `${opts.template.firstStepLabel} ${opts.firstStep}` : null,
    opts.template.returnLine,
  ].filter((line): line is string => Boolean(line?.trim()));
  return lines.join('\n\n');
}

function cleanText(input: unknown): string {
  return typeof input === 'string' ? input.trim() : '';
}

// LANGUAGE-REGEX-OK: encoding-validation guard. The escape sequences U+00C2 / U+00C3 / U+00D0 / U+00D1 are the Latin-1 bytes 0xC2 / 0xC3 / 0xD0 / 0xD1 that appear when UTF-8 multibyte sequences are mis-decoded as Latin-1 (the Cyrillic + em-dash mojibake signature); U+FFFD is the Unicode replacement character. The companion `text.includes(...)` literal catches em-dash (U+2014) mis-decoded as cp1252. Wire-level encoding sniff, not natural-language player intent.
function containsMojibakeMarker(text: string): boolean {
  return /[\u00c2\u00c3\u00d0\u00d1\ufffd]/u.test(text) || text.includes('â€”');
}
