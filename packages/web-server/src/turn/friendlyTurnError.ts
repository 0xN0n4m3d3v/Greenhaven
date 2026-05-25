/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-1 — `friendlyTurnErrorMessage` and the multilingual fallback
// table that translates noisy underlying-stream errors into a
// one-line player-facing hint. Extracted from `turnRunnerV2.ts` so
// the runner stays a thin turn-handle / orchestration file.
//
// Detection patterns:
//   - undici TypeError: terminated  (TLS stream reset by peer)
//   - cause.code === 'ECONNRESET' / 'UND_ERR_SOCKET' / 'ETIMEDOUT' /
//     'UND_ERR_HEADERS_TIMEOUT' / 'UND_ERR_BODY_TIMEOUT' /
//     'ABORT_ERR'
//   - text matches 'aborted' / 'canceled' / 'timeout' / 'timed out'
//   - rate-limit (429 / 'rate limit') / outage (503 / 'upstream')
//
// Anything else passes through unchanged so unknown errors stay
// surfaced verbatim.

import {type SupportedLanguageCode} from '../languages.js';
import {languageBase} from './language.js';

type FriendlyTurnErrorKind =
  | 'stream_reset'
  | 'aborted'
  | 'timeout'
  | 'rate_limit'
  | 'upstream_unavailable';

const FRIENDLY_TURN_ERROR_TEXT: Record<
  SupportedLanguageCode,
  Record<FriendlyTurnErrorKind, string>
> = {
  ar: {
    stream_reset:
      'انقطع الاتصال بالنموذج - أعد الدور. (model TLS stream reset)',
    aborted: 'أُلغي الطلب.',
    timeout: 'لم يجب النموذج في الوقت المناسب - أعد الدور.',
    rate_limit: 'قيّد مزود النموذج الطلبات - انتظر بضع ثوان ثم حاول مرة أخرى.',
    upstream_unavailable: 'مزود النموذج غير متاح - أعد الدور.',
  },
  bn: {
    stream_reset:
      'মডেলের সঙ্গে সংযোগ বিচ্ছিন্ন হয়েছে - চালটি আবার দাও. (model TLS stream reset)',
    aborted: 'অনুরোধ বাতিল হয়েছে।',
    timeout: 'মডেল সময়মতো উত্তর দেয়নি - চালটি আবার দাও।',
    rate_limit:
      'মডেল প্রদানকারী অনুরোধ সীমিত করেছে - কয়েক সেকেন্ড অপেক্ষা করে আবার চেষ্টা করো।',
    upstream_unavailable: 'মডেল প্রদানকারী উপলব্ধ নয় - চালটি আবার দাও।',
  },
  bg: {
    stream_reset:
      'Връзката с модела беше прекъсната - повтори хода. (model TLS stream reset)',
    aborted: 'Заявката е отменена.',
    timeout: 'Моделът не успя да отговори навреме - повтори хода.',
    rate_limit:
      'Доставчикът на модела ограничи заявките - изчакай няколко секунди и опитай пак.',
    upstream_unavailable: 'Доставчикът на модела е недостъпен - повтори хода.',
  },
  de: {
    stream_reset:
      'Die Verbindung zum Modell wurde unterbrochen - wiederhole den Zug. (model TLS stream reset)',
    aborted: 'Die Anfrage wurde abgebrochen.',
    timeout:
      'Das Modell hat nicht rechtzeitig geantwortet - wiederhole den Zug.',
    rate_limit:
      'Der Modellanbieter hat Anfragen begrenzt - warte ein paar Sekunden und versuche es erneut.',
    upstream_unavailable:
      'Der Modellanbieter ist nicht verfügbar - wiederhole den Zug.',
  },
  el: {
    stream_reset:
      'Η σύνδεση με το μοντέλο διακόπηκε - επανάλαβε τον γύρο. (model TLS stream reset)',
    aborted: 'Το αίτημα ακυρώθηκε.',
    timeout: 'Το μοντέλο δεν απάντησε εγκαίρως - επανάλαβε τον γύρο.',
    rate_limit:
      'Ο πάροχος του μοντέλου περιόρισε τα αιτήματα - περίμενε λίγα δευτερόλεπτα και ξαναδοκίμασε.',
    upstream_unavailable:
      'Ο πάροχος του μοντέλου δεν είναι διαθέσιμος - επανάλαβε τον γύρο.',
  },
  en: {
    stream_reset:
      'Connection to the model was interrupted. Repeat the turn. (model TLS stream reset)',
    aborted: 'Request cancelled.',
    timeout: 'The model did not answer in time. Repeat the turn.',
    rate_limit:
      'The model provider rate-limited requests. Wait a few seconds and try again.',
    upstream_unavailable: 'The model provider is unavailable. Repeat the turn.',
  },
  es: {
    stream_reset:
      'La conexión con el modelo se interrumpió - repite el turno. (model TLS stream reset)',
    aborted: 'La solicitud fue cancelada.',
    timeout: 'El modelo no respondió a tiempo - repite el turno.',
    rate_limit:
      'El proveedor del modelo limitó las solicitudes - espera unos segundos e inténtalo de nuevo.',
    upstream_unavailable:
      'El proveedor del modelo no está disponible - repite el turno.',
  },
  fa: {
    stream_reset:
      'اتصال با مدل قطع شد - نوبت را تکرار کن. (model TLS stream reset)',
    aborted: 'درخواست لغو شد.',
    timeout: 'مدل به‌موقع پاسخ نداد - نوبت را تکرار کن.',
    rate_limit:
      'ارائه‌دهنده مدل درخواست‌ها را محدود کرد - چند ثانیه صبر کن و دوباره تلاش کن.',
    upstream_unavailable: 'ارائه‌دهنده مدل در دسترس نیست - نوبت را تکرار کن.',
  },
  fr: {
    stream_reset:
      'La connexion au modèle a été interrompue - répète le tour. (model TLS stream reset)',
    aborted: 'La requête a été annulée.',
    timeout: "Le modèle n'a pas répondu à temps - répète le tour.",
    rate_limit:
      'Le fournisseur du modèle a limité les requêtes - attends quelques secondes puis réessaie.',
    upstream_unavailable:
      'Le fournisseur du modèle est indisponible - répète le tour.',
  },
  he: {
    stream_reset: 'החיבור למודל נקטע - חזור על התור. (model TLS stream reset)',
    aborted: 'הבקשה בוטלה.',
    timeout: 'המודל לא הספיק לענות - חזור על התור.',
    rate_limit: 'ספק המודל הגביל בקשות - המתן כמה שניות ונסה שוב.',
    upstream_unavailable: 'ספק המודל אינו זמין - חזור על התור.',
  },
  hi: {
    stream_reset:
      'मॉडल से कनेक्शन टूट गया - चाल दोहराओ. (model TLS stream reset)',
    aborted: 'अनुरोध रद्द हुआ।',
    timeout: 'मॉडल समय पर जवाब नहीं दे सका - चाल दोहराओ।',
    rate_limit:
      'मॉडल प्रदाता ने अनुरोध सीमित किए - कुछ सेकंड प्रतीक्षा कर फिर कोशिश करो।',
    upstream_unavailable: 'मॉडल प्रदाता उपलब्ध नहीं है - चाल दोहराओ।',
  },
  hy: {
    stream_reset:
      'Մոդելի հետ կապը ընդհատվեց - կրկնիր քայլը. (model TLS stream reset)',
    aborted: 'Հարցումը չեղարկվեց։',
    timeout: 'Մոդելը ժամանակին չպատասխանեց - կրկնիր քայլը։',
    rate_limit:
      'Մոդելի մատակարարը սահմանափակեց հարցումները - սպասիր մի քանի վայրկյան և կրկին փորձիր։',
    upstream_unavailable: 'Մոդելի մատակարարը հասանելի չէ - կրկնիր քայլը։',
  },
  it: {
    stream_reset:
      'La connessione al modello si è interrotta - ripeti il turno. (model TLS stream reset)',
    aborted: 'La richiesta è stata annullata.',
    timeout: 'Il modello non ha risposto in tempo - ripeti il turno.',
    rate_limit:
      'Il provider del modello ha limitato le richieste - attendi qualche secondo e riprova.',
    upstream_unavailable:
      'Il provider del modello non è disponibile - ripeti il turno.',
  },
  ja: {
    stream_reset:
      'モデルとの接続が切れた。ターンをやり直して。 (model TLS stream reset)',
    aborted: 'リクエストはキャンセルされた。',
    timeout: 'モデルの応答が間に合わなかった。ターンをやり直して。',
    rate_limit:
      'モデルプロバイダーがリクエストを制限した。数秒待ってからもう一度試して。',
    upstream_unavailable:
      'モデルプロバイダーを利用できない。ターンをやり直して。',
  },
  ka: {
    stream_reset:
      'მოდელთან კავშირი გაწყდა - გაიმეორე სვლა. (model TLS stream reset)',
    aborted: 'მოთხოვნა გაუქმდა.',
    timeout: 'მოდელმა დროულად ვერ უპასუხა - გაიმეორე სვლა.',
    rate_limit:
      'მოდელის პროვაიდერმა მოთხოვნები შეზღუდა - რამდენიმე წამი დაიცადე და სცადე თავიდან.',
    upstream_unavailable: 'მოდელის პროვაიდერი მიუწვდომელია - გაიმეორე სვლა.',
  },
  ko: {
    stream_reset:
      '모델과의 연결이 끊겼다 - 턴을 다시 입력해라. (model TLS stream reset)',
    aborted: '요청이 취소되었다.',
    timeout: '모델이 제때 응답하지 못했다 - 턴을 다시 입력해라.',
    rate_limit:
      '모델 제공자가 요청을 제한했다 - 몇 초 기다린 뒤 다시 시도해라.',
    upstream_unavailable: '모델 제공자를 사용할 수 없다 - 턴을 다시 입력해라.',
  },
  mr: {
    stream_reset:
      'मॉडेलशी जोडणी तुटली - चाल पुन्हा कर. (model TLS stream reset)',
    aborted: 'विनंती रद्द झाली.',
    timeout: 'मॉडेल वेळेत उत्तर देऊ शकले नाही - चाल पुन्हा कर.',
    rate_limit:
      'मॉडेल पुरवठादाराने विनंत्या मर्यादित केल्या - काही सेकंद थांबून पुन्हा प्रयत्न कर.',
    upstream_unavailable: 'मॉडेल पुरवठादार उपलब्ध नाही - चाल पुन्हा कर.',
  },
  ne: {
    stream_reset:
      'मोडेलसँगको जडान टुट्यो - चाल दोहोर्‍याऊ. (model TLS stream reset)',
    aborted: 'अनुरोध रद्द भयो।',
    timeout: 'मोडेलले समयमा उत्तर दिएन - चाल दोहोर्‍याऊ।',
    rate_limit:
      'मोडेल प्रदायकले अनुरोध सीमित गर्‍यो - केही सेकेन्ड पर्खेर फेरि प्रयास गर।',
    upstream_unavailable: 'मोडेल प्रदायक उपलब्ध छैन - चाल दोहोर्‍याऊ।',
  },
  pt: {
    stream_reset:
      'A ligação ao modelo foi interrompida - repete o turno. (model TLS stream reset)',
    aborted: 'O pedido foi cancelado.',
    timeout: 'O modelo não respondeu a tempo - repete o turno.',
    rate_limit:
      'O fornecedor do modelo limitou os pedidos - espera alguns segundos e tenta de novo.',
    upstream_unavailable:
      'O fornecedor do modelo está indisponível - repete o turno.',
  },
  ro: {
    stream_reset:
      'Conexiunea cu modelul a fost întreruptă - repetă tura. (model TLS stream reset)',
    aborted: 'Cererea a fost anulată.',
    timeout: 'Modelul nu a răspuns la timp - repetă tura.',
    rate_limit:
      'Furnizorul modelului a limitat cererile - așteaptă câteva secunde și încearcă din nou.',
    upstream_unavailable:
      'Furnizorul modelului nu este disponibil - repetă tura.',
  },
  ru: {
    stream_reset:
      'Соединение с моделью прервано - повтори ход. (model TLS stream reset)',
    aborted: 'Запрос отменён.',
    timeout: 'Модель не успела ответить - повтори ход.',
    rate_limit:
      'Провайдер модели ограничил запросы - подожди пару секунд и повтори.',
    upstream_unavailable: 'Провайдер модели недоступен - повтори ход.',
  },
  sr: {
    stream_reset:
      'Veza sa modelom je prekinuta - ponovi potez. (model TLS stream reset)',
    aborted: 'Zahtev je otkazan.',
    timeout: 'Model nije stigao da odgovori - ponovi potez.',
    rate_limit:
      'Provider modela je ograničio zahteve - sačekaj nekoliko sekundi i pokušaj ponovo.',
    upstream_unavailable: 'Provider modela nije dostupan - ponovi potez.',
  },
  th: {
    stream_reset:
      'การเชื่อมต่อกับโมเดลขาดหาย - เล่นเทิร์นซ้ำอีกครั้ง. (model TLS stream reset)',
    aborted: 'คำขอถูกยกเลิก',
    timeout: 'โมเดลตอบไม่ทันเวลา - เล่นเทิร์นซ้ำอีกครั้ง',
    rate_limit: 'ผู้ให้บริการโมเดลจำกัดคำขอ - รอสักครู่แล้วลองใหม่',
    upstream_unavailable:
      'ผู้ให้บริการโมเดลไม่พร้อมใช้งาน - เล่นเทิร์นซ้ำอีกครั้ง',
  },
  uk: {
    stream_reset:
      'Зʼєднання з моделлю перервано - повтори хід. (model TLS stream reset)',
    aborted: 'Запит скасовано.',
    timeout: 'Модель не встигла відповісти - повтори хід.',
    rate_limit:
      'Провайдер моделі обмежив запити - зачекай кілька секунд і повтори.',
    upstream_unavailable: 'Провайдер моделі недоступний - повтори хід.',
  },
  ur: {
    stream_reset:
      'ماڈل سے رابطہ ٹوٹ گیا - باری دوبارہ دو. (model TLS stream reset)',
    aborted: 'درخواست منسوخ ہو گئی۔',
    timeout: 'ماڈل وقت پر جواب نہ دے سکا - باری دوبارہ دو۔',
    rate_limit:
      'ماڈل فراہم کنندہ نے درخواستیں محدود کر دیں - چند سیکنڈ انتظار کر کے دوبارہ کوشش کرو۔',
    upstream_unavailable: 'ماڈل فراہم کنندہ دستیاب نہیں - باری دوبارہ دو۔',
  },
  zh: {
    stream_reset:
      '与模型的连接中断了 - 请重试这一回合。 (model TLS stream reset)',
    aborted: '请求已取消。',
    timeout: '模型未及时响应 - 请重试这一回合。',
    rate_limit: '模型提供方限制了请求 - 请等待几秒后再试。',
    upstream_unavailable: '模型提供方不可用 - 请重试这一回合。',
  },
};

function friendlyTurnErrorText(
  kind: FriendlyTurnErrorKind,
  language: string | undefined,
): string {
  const byLanguage =
    FRIENDLY_TURN_ERROR_TEXT[languageBase(language) as SupportedLanguageCode] ??
    FRIENDLY_TURN_ERROR_TEXT['en']!;
  return byLanguage[kind];
}

export function friendlyTurnErrorMessage(
  err: unknown,
  raw: string,
  language?: string,
): string {
  const cause =
    typeof err === 'object' && err !== null
      ? (err as {cause?: unknown}).cause
      : undefined;
  const causeCode =
    cause && typeof cause === 'object' && cause !== null
      ? (cause as {code?: unknown}).code
      : undefined;
  const text = raw.toLowerCase();
  // undici stream reset
  if (
    text === 'terminated' ||
    causeCode === 'ECONNRESET' ||
    causeCode === 'UND_ERR_SOCKET'
  ) {
    return friendlyTurnErrorText('stream_reset', language);
  }
  // abort
  if (
    text.includes('aborted') ||
    text.includes('canceled') ||
    causeCode === 'ABORT_ERR'
  ) {
    return friendlyTurnErrorText('aborted', language);
  }
  // timeout
  if (
    text.includes('timeout') ||
    text.includes('timed out') ||
    causeCode === 'ETIMEDOUT' ||
    causeCode === 'UND_ERR_HEADERS_TIMEOUT' ||
    causeCode === 'UND_ERR_BODY_TIMEOUT'
  ) {
    return friendlyTurnErrorText('timeout', language);
  }
  // rate / outage
  if (text.includes('429') || text.includes('rate limit')) {
    return friendlyTurnErrorText('rate_limit', language);
  }
  if (text.includes('503') || text.includes('upstream')) {
    return friendlyTurnErrorText('upstream_unavailable', language);
  }
  return raw;
}
