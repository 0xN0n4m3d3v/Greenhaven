import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  localizedActionText,
  localizedAffordanceMessage,
  localizedTalkMessage,
} from '../src/lib/actionText';
import {bootTextForLanguage} from '../src/lib/bootI18n';
import {SUPPORTED_LANGUAGES} from '../src/lib/languages';
import {
  BASE_MESSAGES,
  UI_MESSAGES,
  validateUiMessageCatalog,
} from '../src/lib/uiMessages';

type ActionTextKey = Parameters<typeof localizedActionText>[0];

const ACTION_KEYS: ActionTextKey[] = [
  'travel.location',
  'travel.scene',
  'item.look',
  'item.check',
  'social.persuade',
  'social.intimidate',
  'social.deceive',
  'social.seduce',
  'social.insight',
  'attack',
  'string.spend',
  'inspiration.spend',
];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..');
const srcRoot = path.join(packageRoot, 'src');

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function assertUiCatalog(): void {
  validateUiMessageCatalog();
  const baseKeys = Object.keys(BASE_MESSAGES['en'] ?? {});
  for (const language of SUPPORTED_LANGUAGES) {
    const messages = UI_MESSAGES[language.code];
    assert(messages, `missing UI message catalog for ${language.code}`);
    const keys = Object.keys(messages);
    assert(
      keys.length === baseKeys.length,
      `UI message catalog ${language.code} key count mismatch: ${keys.length} !== ${baseKeys.length}`,
    );
  }
}

function assertBootCatalog(): void {
  for (const language of SUPPORTED_LANGUAGES) {
    const text = bootTextForLanguage(language.code);
    for (const [key, value] of Object.entries(text)) {
      assert(
        typeof value === 'string' && value.trim().length > 0,
        `boot text ${language.code}.${key} is empty`,
      );
    }
  }
}

function assertActionTextCatalog(): void {
  for (const language of SUPPORTED_LANGUAGES) {
    for (const key of ACTION_KEYS) {
      const text = localizedActionText(key, {name: 'Example Target'}, language.code);
      assert(text.trim().length > 0, `action text ${language.code}.${key} is empty`);
    }
    const talk = localizedTalkMessage({name: 'Example Target'}, language.code);
    assert(talk.trim().length > 0, `talk text ${language.code} is empty`);
  }

  const romanianAttack = localizedActionText('attack', {name: 'Example Target'}, 'ro');
  const arabicTalk = localizedTalkMessage({name: 'Example Target'}, 'ar');
  const arabicAffordance = localizedAffordanceMessage(
    {
      kind: 'social-seduce',
      entityName: 'Example Target',
      messageKey: 'social.seduce',
      messageVars: {name: 'Example Target'},
    },
    'ar',
  );
  assert(!/\bI attack\b/i.test(romanianAttack), 'Romanian attack fell back to English');
  assert(!/\bI speak\b/i.test(arabicTalk), 'Arabic talk fell back to English');
  assert(!/\bI try to seduce\b/i.test(arabicAffordance), 'Arabic affordance fell back to English');
}

async function listSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, {withFileTypes: true});
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      files.push(...await listSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

function shouldScanHardcodedActions(file: string): boolean {
  const relative = path.relative(srcRoot, file).replace(/\\/g, '/');
  if (
    relative === 'lib/actionText.ts' ||
    relative === 'lib/uiMessages.ts' ||
    relative === 'lib/translationExtras.ts' ||
    relative === 'lib/bootI18n.ts'
  ) {
    return false;
  }
  return (
    relative === 'App.tsx' ||
    relative === 'WizardGate.tsx' ||
    relative.startsWith('components/') ||
    relative.startsWith('lib/mentions')
  );
}

async function assertNoHardcodedPlayerActionSentences(): Promise<void> {
  const patterns = [
    /\bI\s+(move|enter|take|examine|try|attack|lean|draw|speak|talk|watch)\b/i,
    /\b(Persuade|Intimidate|Deceive|Seduce|Attack|Read)\s+@\{?name/i,
    /\blook around for hooks\b/i,
  ];
  const offenders: string[] = [];
  for (const file of (await listSourceFiles(srcRoot)).filter(shouldScanHardcodedActions)) {
    const text = await readFile(file, 'utf8');
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) return;
      if (patterns.some(pattern => pattern.test(line))) {
        offenders.push(`${path.relative(packageRoot, file)}:${index + 1}: ${trimmed}`);
      }
    });
  }
  assert(
    offenders.length === 0,
    `hardcoded English player-action text found outside actionText.ts:\n${offenders.join('\n')}`,
  );
}

// Scan source for `t('...')` and `label('...', ...)` usages and fail if
// any referenced key is absent from BASE_MESSAGES.en. This catches the
// silent-fallback pattern that previously hid missing creator keys
// (FE-2026-05-06-first-run-i18n-hardening).
//
// Heuristic: the patterns look at `t(` / `label(` followed by a quoted
// literal whose contents look like a dotted i18n key (lowercase, dots,
// or section.literals like creator.aspects.label.${aspect.key}). Only
// keys that are fully-static literals (no template interpolation, no
// concatenation) are checked; dynamic keys are out of scope and
// deliberately ignored to avoid false positives.
async function assertReferencedKeysExistInBase(): Promise<void> {
  const baseKeys = new Set(Object.keys(BASE_MESSAGES['en'] ?? {}));
  // Allow dynamic prefixes used inside the creator: `creator.aspects.label.<x>`
  // and `creator.aspects.desc.<x>`. We register their concrete forms in
  // the catalog already; static literals matching these prefixes still
  // need to exist exactly.
  const tCallPattern = /\b(?:t|label)\(\s*'([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)'/gi;
  const offenders: string[] = [];
  for (const file of await listSourceFiles(srcRoot)) {
    const relative = path.relative(srcRoot, file).replace(/\\/g, '/');
    if (
      relative === 'lib/uiMessages.ts' ||
      relative === 'lib/translationExtras.ts' ||
      relative === 'lib/bootI18n.ts' ||
      relative === 'lib/actionText.ts'
    ) continue;
    const text = await readFile(file, 'utf8');
    let match: RegExpExecArray | null;
    while ((match = tCallPattern.exec(text)) != null) {
      const key = match[1];
      if (!key || baseKeys.has(key)) continue;
      // Allow well-known dynamic keyspaces that are constructed at
      // call sites (e.g. examiner question keys built from a list).
      if (
        key.startsWith('ui.event_card.') ||
        key.startsWith('sessions.atlas.kind.') ||
        key.startsWith('sessions.memory.category.') ||
        key.startsWith('sessions.stage.')
      ) continue;
      offenders.push(`${path.relative(packageRoot, file)}: ${key}`);
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      'i18n keys referenced in source but missing from BASE_MESSAGES.en:\n' +
      offenders.join('\n'),
    );
  }
}

async function main(): Promise<void> {
  assertUiCatalog();
  assertBootCatalog();
  assertActionTextCatalog();
  await assertNoHardcodedPlayerActionSentences();
  await assertReferencedKeysExistInBase();
  console.log(JSON.stringify({
    ok: true,
    languages: SUPPORTED_LANGUAGES.map(language => language.code),
    uiKeys: Object.keys(BASE_MESSAGES['en'] ?? {}).length,
    actionKeys: ACTION_KEYS.length,
  }));
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
