/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Spec 139 - player-local living world packet.
// This records only the world slice the player can perceive. It is deliberately
// grounded in existing cartridge/i18n/memory data and does not run an off-screen
// autonomous simulation.

import { query } from '../../../db.js';

export interface LocationVisitRecord {
  locationId: number;
  locationName: string;
  firstVisit: boolean;
  enteredNow: boolean;
  visitCount: number;
  introBubble: string | null;
}

export interface LocationMemoryPacket {
  locationId: number;
  locationName: string;
  visitCount: number;
  enteredThisTurn: boolean;
  introBubble: string | null;
  profileFrame: LocationProfileFrame | null;
  memories: LocationMemoryRow[];
}

export interface LocationProfileFrame {
  locationCanon: string | null;
  locationBrief: string | null;
  locationRules: string | null;
  sensoryIdentity: string | null;
  visibleExitsProse: string | null;
  pointsOfInterest: string | null;
  immediatePlayerActions: string | null;
  hostilePressure: string | null;
  adventureThreat: string | null;
  locationMemoryHooks: string | null;
  publicScenesProse: string | null;
  companionStake: string | null;
}

export interface LocationMemoryRow {
  id: number;
  text: string;
  importance: number;
  salience: number;
  memory_kind: string;
  memory_family: string;
  cluster_id: string | null;
  tags: string[];
}

interface PlayerLocationRow {
  current_location_id: number | string | null;
  metadata: Record<string, unknown> | null;
}

interface VisitRow {
  visit_count: number;
  metadata: Record<string, unknown> | null;
}

interface LocalizedLocationRow {
  id: number;
  display_name: string;
  profile: Record<string, unknown> | null;
}

interface LocationIntroFallbackRow {
  display_name: string;
  summary: string | null;
}

const CYRILLIC_LANGUAGE_BASES = new Set(['ru', 'uk', 'bg', 'sr']);
const LOCATION_FRAME_VALUE_LIMIT = 900;

export async function recordCurrentLocationVisit(opts: {
  playerId: number;
  sessionId?: string | null;
  turnId?: string | null;
  lang?: string;
}): Promise<LocationVisitRecord | null> {
  const row = await query<PlayerLocationRow>(
    `SELECT current_location_id, metadata
       FROM players
      WHERE entity_id = $1`,
    [opts.playerId],
  );
  const player = row.rows[0];
  const locationId = readPositiveId(player?.current_location_id);
  if (locationId == null) return null;
  return recordLocationVisit({
    playerId: opts.playerId,
    locationId,
    sessionId: opts.sessionId,
    turnId: opts.turnId,
    lang: opts.lang,
    previousLocationId: readPositiveId(player?.metadata?.['last_location_id']),
  });
}

export async function recordLocationVisit(opts: {
  playerId: number;
  locationId: number;
  sessionId?: string | null;
  turnId?: string | null;
  lang?: string;
  previousLocationId?: number | null;
  forceEntry?: boolean;
}): Promise<LocationVisitRecord> {
  const existing = await query<VisitRow>(
    `SELECT visit_count, metadata
       FROM player_location_visits
      WHERE player_id = $1
        AND location_entity_id = $2`,
    [opts.playerId, opts.locationId],
  );
  const firstVisit = existing.rows.length === 0;
  const enteredNow =
    opts.forceEntry === true ||
    firstVisit ||
    opts.previousLocationId == null ||
    opts.previousLocationId !== opts.locationId;
  const entryMetadata = enteredNow
    ? {
        last_entry_turn_id: opts.turnId ?? null,
        last_entry_session_id: opts.sessionId ?? null,
        last_entry_at: new Date().toISOString(),
      }
    : {};
  const visit = await query<VisitRow>(
    `INSERT INTO player_location_visits
       (player_id, location_entity_id, visit_count, last_intro_at, metadata)
     VALUES ($1, $2, 1, now(), $4::jsonb)
     ON CONFLICT (player_id, location_entity_id) DO UPDATE SET
       last_seen_at = now(),
       visit_count = player_location_visits.visit_count + CASE WHEN $3 THEN 1 ELSE 0 END,
       last_intro_at = CASE WHEN $3 THEN now() ELSE player_location_visits.last_intro_at END,
       metadata = COALESCE(player_location_visits.metadata, '{}'::jsonb) || $4::jsonb
     RETURNING visit_count, metadata`,
    [opts.playerId, opts.locationId, enteredNow, JSON.stringify(entryMetadata)],
  );
  await query(
    `UPDATE players
        SET metadata = COALESCE(metadata, '{}'::jsonb)
                    || jsonb_build_object(
                         'last_location_id', $1::bigint,
                         'last_location_seen_at', $2::text
                       )
      WHERE entity_id = $3`,
    [opts.locationId, new Date().toISOString(), opts.playerId],
  );
  if (enteredNow) {
    await bumpLocationMemorySalience(
      opts.locationId,
      opts.playerId,
      firstVisit,
    );
  }
  const lang = opts.lang ?? (await loadPlayerPreferredLanguage(opts.playerId));
  const locationName =
    (await loadLocationDisplayName(opts.locationId)) ??
    String(opts.locationId);
  return {
    locationId: opts.locationId,
    locationName,
    firstVisit,
    enteredNow,
    visitCount: Number(visit.rows[0]?.visit_count ?? 1),
    introBubble: firstVisit
      ? await loadIntroBubble(opts.locationId, lang ?? 'en')
      : null,
  };
}

async function bumpLocationMemorySalience(
  locationId: number,
  playerId: number,
  firstVisit: boolean,
): Promise<void> {
  const bump = firstVisit ? 0.02 : 0.04;
  await query(
    `UPDATE npc_memories
        SET salience = LEAST(1.0, COALESCE(salience, importance, 0) + $3::real),
            updated_at = now()
      WHERE owner_entity_id = $1
        AND (about_entity_id IS NULL OR about_entity_id = $2)`,
    [locationId, playerId, bump],
  );
}

export async function buildLocationMemoryPacket(opts: {
  playerId: number;
  locationId: number;
  lang?: string;
  turnId?: string | null;
  memoryLimit?: number;
}): Promise<LocationMemoryPacket | null> {
  const lang = languageBase(opts.lang);
  const location = await query<LocalizedLocationRow>(
    `SELECT id,
            display_name,
            profile
       FROM entities
      WHERE id = $1
        AND kind IN ('location', 'district')`,
    [opts.locationId],
  );
  const loc = location.rows[0];
  if (!loc) return null;

  const visits = await query<VisitRow>(
    `SELECT visit_count, metadata
       FROM player_location_visits
      WHERE player_id = $1
        AND location_entity_id = $2`,
    [opts.playerId, opts.locationId],
  );
  const visit = visits.rows[0] ?? { visit_count: 0, metadata: null };
  const lastEntryTurnId = readText(visit.metadata?.['last_entry_turn_id']);
  const visitCount = Number(visit.visit_count ?? 0);
  const enteredThisTurn =
    opts.turnId != null && lastEntryTurnId != null
      ? lastEntryTurnId === opts.turnId
      : visitCount === 1;
  const memories = await query<LocationMemoryRow>(
    `SELECT id, text, importance, salience, memory_kind, memory_family,
            cluster_id, tags
       FROM npc_memories
      WHERE owner_entity_id = $1
        AND (about_entity_id IS NULL OR about_entity_id = $2)
      ORDER BY salience DESC, importance DESC, updated_at DESC, id DESC
      LIMIT $3`,
    [opts.locationId, opts.playerId, opts.memoryLimit ?? 6],
  );

  return {
    locationId: opts.locationId,
    locationName: loc.display_name,
    visitCount,
    enteredThisTurn,
    introBubble: enteredThisTurn && visitCount === 1
      ? await loadIntroBubble(opts.locationId, lang)
      : null,
    profileFrame: readLocationProfileFrame(loc.profile),
    memories: memories.rows,
  };
}

export function renderLocationMemoryPacket(
  packet: LocationMemoryPacket | null,
): string | null {
  if (!packet) return null;
  const lines = [
    '## LOCATION MEMORY',
    `Location: @${packet.locationName} (${packet.locationId}) - visit #${Math.max(1, packet.visitCount)}`,
  ];
  if (packet.introBubble) {
    lines.push(`First-entry bubble: ${packet.introBubble}`);
    lines.push(
      'First-entry directive: surface at least one grounded next action from PEOPLE HERE, ITEMS HERE, EXITS, ACTIVE QUESTS, local memories, or a diegetic question.',
    );
  }
  const profileFrame = renderLocationProfileFrame(packet.profileFrame);
  if (profileFrame.length > 0) {
    lines.push('Cartridge location frame:');
    lines.push(...profileFrame.map((line) => `  - ${line}`));
    lines.push(
      'Frame directive: prefer this authored frame for visible sensory details, exits, threats, public scenes, and next actions; do not replace it with generic filler.',
    );
  }
  if (packet.memories.length > 0) {
    lines.push('Local continuity:');
    for (const memory of packet.memories) {
      const cluster = memory.cluster_id ? ` cluster=${memory.cluster_id}` : '';
      lines.push(
        `  - #${memory.id} [${memory.memory_family}/${memory.memory_kind} salience=${formatScore(memory.salience)}${cluster}] ${memory.text}`,
      );
    }
  } else {
    lines.push('Local continuity: no durable local memories yet.');
  }
  lines.push(
    'Rule: use local continuity before inventing changed state; write new location consequences as location-owned memories or runtime fields.',
  );
  return lines.join('\n');
}

function readLocationProfileFrame(
  value: unknown,
): LocationProfileFrame | null {
  const profile = readRecord(value);
  if (!profile) return null;
  const frame: LocationProfileFrame = {
    locationCanon: readText(profile['location_canon']),
    locationBrief: readText(profile['location_brief']),
    locationRules: readText(profile['location_rules']),
    sensoryIdentity: readText(profile['sensory_identity']),
    visibleExitsProse: readText(profile['visible_exits_prose']),
    pointsOfInterest: readText(profile['points_of_interest']),
    immediatePlayerActions: readText(profile['immediate_player_actions']),
    hostilePressure: readText(profile['hostile_pressure']),
    adventureThreat: readText(profile['adventure_threat']),
    locationMemoryHooks: readText(profile['location_memory_hooks']),
    publicScenesProse: readText(profile['public_scenes_prose']),
    companionStake: readText(profile['companion_stake']),
  };
  return Object.values(frame).some((entry) => entry != null) ? frame : null;
}

function renderLocationProfileFrame(
  frame: LocationProfileFrame | null,
): string[] {
  if (!frame) return [];
  const entries: Array<[string, string | null]> = [
    ['Canon', frame.locationCanon],
    ['Brief', frame.locationBrief],
    ['Location rules', frame.locationRules],
    ['Sensory identity', frame.sensoryIdentity],
    ['Visible exits', frame.visibleExitsProse],
    ['Points of interest', frame.pointsOfInterest],
    ['Immediate actions', frame.immediatePlayerActions],
    ['Hostile pressure', frame.hostilePressure],
    ['Adventure threat', frame.adventureThreat],
    ['Memory hooks', frame.locationMemoryHooks],
    ['Public scenes', frame.publicScenesProse],
    ['Companion stake', frame.companionStake],
  ];
  return entries.flatMap(([label, value]) =>
    value ? [`${label}: ${clipFrameText(value)}`] : [],
  );
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function clipFrameText(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= LOCATION_FRAME_VALUE_LIMIT) return compact;
  return `${compact.slice(0, LOCATION_FRAME_VALUE_LIMIT - 1).trimEnd()}...`;
}

export async function loadIntroBubble(
  locationId: number,
  lang: string,
): Promise<string | null> {
  const normalizedLang = languageBase(lang);
  const rows = await query<{ lang: string; bubble_text: string }>(
    `SELECT lang, bubble_text
       FROM location_intro_bubbles
      WHERE location_entity_id = $1
        AND lang = ANY($2::text[])
      ORDER BY CASE WHEN lang = $3 THEN 0 WHEN lang = 'en' THEN 1 ELSE 2 END
      LIMIT 1`,
    [locationId, [normalizedLang, 'en'], normalizedLang],
  );
  const exact = rows.rows.find((row) => row.lang === normalizedLang);
  const english = rows.rows.find((row) => row.lang === 'en');
  const exactSeed = readText(exact?.bubble_text);
  const englishSeed = readText(english?.bubble_text);
  const selectedSeed =
    normalizedLang === 'en' ? (exactSeed ?? englishSeed) : (exactSeed ?? null);
  const exactIsEnglishBackfill =
    normalizedLang !== 'en' &&
    exactSeed != null &&
    englishSeed != null &&
    exactSeed === englishSeed;
  if (
    selectedSeed &&
    !exactIsEnglishBackfill &&
    !looksWrongLanguage(selectedSeed, normalizedLang)
  ) {
    return selectedSeed;
  }

  const fallback = await query<LocationIntroFallbackRow>(
    `SELECT
       display_name,
       COALESCE(NULLIF(i18n->'summary'->>$2, ''), summary) AS summary
     FROM entities
     WHERE id = $1
       AND kind IN ('location', 'district')`,
    [locationId, normalizedLang],
  );
  const location = fallback.rows[0];
  if (!location) return null;
  const name = readText(location.display_name);
  if (!name) return null;
  const summary = readText(location.summary);
  return buildLocalizedIntroBubble(
    name,
    summary && !looksWrongLanguage(summary, normalizedLang) ? summary : null,
    normalizedLang,
  );
}

async function loadLocationDisplayName(locationId: number): Promise<string | null> {
  const row = await query<{ display_name: string }>(
    `SELECT display_name
       FROM entities
      WHERE id = $1
        AND kind IN ('location', 'district')`,
    [locationId],
  );
  return readText(row.rows[0]?.display_name);
}

async function loadPlayerPreferredLanguage(
  playerId: number,
): Promise<string | null> {
  const row = await query<{ preferred_language: string | null }>(
    `SELECT preferred_language FROM players WHERE entity_id = $1`,
    [playerId],
  );
  return readText(row.rows[0]?.preferred_language);
}

function buildLocalizedIntroBubble(
  name: string,
  summary: string | null,
  lang: string,
): string {
  if (summary) return `@${name} - ${summary}`;
  switch (languageBase(lang)) {
    case 'en':
      return `@${name} — first entry. You pause at the threshold and read the place quickly: who is here, what is visible, where the exits lead, and which hook wants attention first.`;
    case 'ru':
      return `@${name} — первый вход. Ты задерживаешься на пороге и быстро считываешь место: кто здесь, что лежит на виду, куда ведут выходы и какая зацепка просится первой.`;
    case 'uk':
      return `@${name} — перший вхід. Ти затримуєшся на порозі й швидко зчитуєш місце: хто тут, що лежить на видноті, куди ведуть виходи і яка зачіпка проситься першою.`;
    case 'bg':
      return `@${name} — първо влизане. Спираш на прага и бързо оглеждаш мястото: кой е тук, какво се вижда, накъде водят изходите и коя следа първа иска внимание.`;
    case 'sr':
      return `@${name} — први улазак. Застајеш на прагу и брзо читаш место: ко је овде, шта је на видику, куда воде излази и који траг први тражи пажњу.`;
    case 'es':
      return `@${name} — primera entrada. Te detienes en el umbral y lees el lugar: quién está aquí, qué queda a la vista, adónde llevan las salidas y qué pista exige atención.`;
    case 'fr':
      return `@${name} — première entrée. Tu t'arrêtes au seuil et lis vite les lieux : qui est là, ce qui se voit, où mènent les sorties et quelle piste appelle d'abord.`;
    case 'de':
      return `@${name} — erster Eintritt. Du hältst an der Schwelle inne und erfasst den Ort: wer hier ist, was offen sichtbar liegt, wohin die Ausgänge führen und welcher Hinweis zuerst zählt.`;
    case 'it':
      return `@${name} — primo ingresso. Ti fermi sulla soglia e leggi il luogo: chi è qui, cosa si vede, dove portano le uscite e quale indizio chiede attenzione.`;
    case 'pt':
      return `@${name} — primeira entrada. Você para na soleira e lê o lugar: quem está aqui, o que está à vista, para onde levam as saídas e qual pista pede atenção.`;
    case 'ro':
      return `@${name} — prima intrare. Te oprești în prag și citești locul: cine este aici, ce se vede, unde duc ieșirile și ce indiciu cere primul atenție.`;
    case 'he':
      return `@${name} — כניסה ראשונה. אתה נעצר בפתח וקורא את המקום במהירות: מי כאן, מה גלוי לעין, לאן מובילות היציאות ואיזה רמז דורש תשומת לב ראשון.`;
    case 'ar':
      return `@${name} — الدخول الأول. تتوقف عند العتبة وتقرأ المكان بسرعة: من هنا، ما الظاهر للعين، إلى أين تقود المخارج، وأي خيط يستحق الانتباه أولاً.`;
    case 'fa':
      return `@${name} — ورود نخست. روی آستانه مکث می‌کنی و جا را سریع می‌خوانی: چه کسی اینجاست، چه چیزی پیداست، خروجی‌ها به کجا می‌روند و کدام سرنخ اول توجه می‌خواهد.`;
    case 'ur':
      return `@${name} — پہلی آمد۔ تم دہلیز پر رک کر جگہ کو جلدی پڑھتے ہو: یہاں کون ہے، کیا صاف دکھائی دے رہا ہے، راستے کہاں جاتے ہیں، اور کون سا اشارہ پہلے توجہ چاہتا ہے۔`;
    case 'hi':
      return `@${name} — पहला प्रवेश। तुम दहलीज़ पर रुककर जगह को जल्दी पढ़ते हो: यहाँ कौन है, क्या दिख रहा है, निकास कहाँ जाते हैं, और कौन-सा सुराग पहले ध्यान माँगता है।`;
    case 'mr':
      return `@${name} — पहिला प्रवेश. तू उंबरठ्यावर थांबून जागा झटपट वाचतोस: इथे कोण आहे, काय दिसते, बाहेरचे मार्ग कुठे जातात आणि कोणता धागा आधी लक्ष मागतो.`;
    case 'ne':
      return `@${name} — पहिलो प्रवेश। तिमी ढोकामै अडिएर ठाउँलाई छिटो पढ्छौ: यहाँ को छ, के देखिन्छ, निकास कहाँ जान्छन्, र कुन संकेतले पहिले ध्यान माग्छ।`;
    case 'bn':
      return `@${name} — প্রথম প্রবেশ। তুমি দোরগোড়ায় থেমে জায়গাটা দ্রুত পড়ে নাও: এখানে কে আছে, কী দেখা যাচ্ছে, বেরোনোর পথ কোথায় যায়, আর কোন সূত্র আগে নজর চায়।`;
    case 'th':
      return `@${name} — เข้าครั้งแรก คุณหยุดที่ธรณีประตูและอ่านสถานที่อย่างรวดเร็ว: ใครอยู่ที่นี่ อะไรเห็นได้ชัด ทางออกพาไปไหน และเบาะแสใดควรสนใจก่อน`;
    case 'el':
      return `@${name} — πρώτη είσοδος. Στέκεσαι στο κατώφλι και διαβάζεις γρήγορα τον χώρο: ποιος είναι εδώ, τι φαίνεται, πού οδηγούν οι έξοδοι και ποιο ίχνος ζητά πρώτο προσοχή.`;
    case 'hy':
      return `@${name} — առաջին մուտք։ Կանգնում ես շեմին ու արագ կարդում վայրը՝ ով է այստեղ, ինչ է երևում, ուր են տանում ելքերը և որ հետքն է առաջինը ուշադրություն պահանջում։`;
    case 'ka':
      return `@${name} — პირველი შესვლა. ზღურბლთან ჩერდები და ადგილს სწრაფად კითხულობ: ვინ არის აქ, რა ჩანს, სად მიდის გასასვლელები და რომელი კვალი ითხოვს პირველ ყურადღებას.`;
    case 'ko':
      return `@${name} — 첫 방문. 문턱에서 잠시 멈춰 장소를 빠르게 읽는다: 누가 있는지, 무엇이 보이는지, 출구가 어디로 이어지는지, 어떤 단서가 먼저 눈길을 끄는지.`;
    case 'ja':
      return `@${name} — 初めての入場。君は入口で足を止め、この場所を素早く読む。誰がいるか、何が見えるか、出口はどこへ続くか、最初に注目すべき手がかりは何か。`;
    case 'zh':
      return `@${name} — 初次进入。你在门口停下，迅速读懂这个地点：谁在这里，什么摆在眼前，出口通向哪里，哪条线索最值得先看。`;
    default:
      return `@${name} — first entry. You pause at the threshold and read the place quickly: who is here, what is visible, where the exits lead, and which hook wants attention first.`;
  }
}

function looksWrongLanguage(text: string, lang: string): boolean {
  const normalizedLang = languageBase(lang);
  if (!CYRILLIC_LANGUAGE_BASES.has(normalizedLang)) return false;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  const cyrillic = (text.match(/[\u0400-\u04FF]/g) ?? []).length;
  return latin >= 24 && cyrillic < 8 && latin > cyrillic * 3;
}

function languageBase(lang: string | undefined): string {
  return (lang ?? 'en').trim().toLowerCase().split(/[-_]/)[0] || 'en';
}

function readPositiveId(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function readText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function formatScore(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : '0.00';
}
