#!/usr/bin/env node

import {existsSync, readFileSync, readdirSync, statSync} from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const srcRoot = path.join(repoRoot, 'src');

const blockers = [];

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === 'dist' || entry === 'node_modules') continue;
      walk(full, files);
    } else if (/\.(ts|tsx|css)$/.test(entry)) {
      files.push(full);
    }
  }
  return files;
}

function rel(file) {
  return path.relative(repoRoot, file).replaceAll(path.sep, '/');
}

function add(pattern, file, detail) {
  blockers.push({pattern, file: rel(file), detail});
}

const files = walk(srcRoot);
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const checks = [
    ['retired RecoveryModal', /RecoveryModal/],
    ['retired recovery UI state', /\b(recoveryCode|setRecoveryCode)\b/],
    ['retired recovery event', /player:recovery_code/],
    ['retired recovery i18n key', /ui\.recovery\./],
    ['retired recovery CSS', /recovery-modal/],
    ['retired character wizard CSS', /char-wizard/],
    ['retired cartridge recovery panel', /cart-lib__recovery/],
    ['retired hero recovery panel', /hero-creator-screen__panel--recovery/],
    ['retired compact quest panel CSS', /quest-panel|quest-card/],
    ['retired compact quest panel i18n key', /ui\.quest_panel\./],
    ['retired self-profile modal', /SelfProfileModal/],
    ['stale milestone placeholder copy', /arrives with the next milestone/],
    ['hidden focus outline', /outline:\s*none(?:\s*!important)?\s*;/],
  ];
  for (const [name, regex] of checks) {
    if (regex.test(text)) add(name, file, regex.source);
  }
}

for (const retiredPath of [
  path.join(srcRoot, 'components', 'QuestPanel.tsx'),
  path.join(srcRoot, 'components', 'modals', 'SelfProfileModal.tsx'),
  path.join(srcRoot, 'bridge', 'quests.ts'),
]) {
  if (existsSync(retiredPath)) {
    add('retired compact quest panel file', retiredPath, 'file should stay deleted');
  }
}

const autoScroll = readFileSync(
  path.join(srcRoot, 'hooks', 'useAutoScroll.ts'),
  'utf8',
);
if (!/firstNewNonPlayerItem/.test(autoScroll)) {
  add(
    'chat first-new-item scroll guard',
    path.join(srcRoot, 'hooks', 'useAutoScroll.ts'),
    'missing firstNewNonPlayerItem',
  );
}
if (!/awaitingFirstPostPlayerItem/.test(autoScroll)) {
  add(
    'chat scroll waits only once per player turn',
    path.join(srcRoot, 'hooks', 'useAutoScroll.ts'),
    'missing awaitingFirstPostPlayerItem',
  );
}

const mentions = readFileSync(path.join(srcRoot, 'lib', 'mentions.tsx'), 'utf8');
if (!/onClick=\{\(\) => onMention\(mention\.target\)\}/.test(mentions)) {
  add(
    'inline mention click contract',
    path.join(srcRoot, 'lib', 'mentions.tsx'),
    'mention button no longer opens onMention',
  );
}

const viteConfig = readFileSync(path.join(repoRoot, 'vite.config.ts'), 'utf8');
if (!/rolldownOptions[\s\S]*codeSplitting[\s\S]*vendor-react/.test(viteConfig)) {
  add(
    'web build chunking contract',
    path.join(repoRoot, 'vite.config.ts'),
    'missing Rolldown codeSplitting groups for the UI vendor/app chunks',
  );
}

const bridgeApi = readFileSync(path.join(srcRoot, 'bridge', 'api.ts'), 'utf8');
if (/from ['"]\.\.\/lib\/uiMessages['"]/.test(bridgeApi)) {
  add(
    'lazy translation chunk contract',
    path.join(srcRoot, 'bridge', 'api.ts'),
    'uiMessages must stay dynamically imported by GetTranslations',
  );
}
if (!/await import\(['"]\.\.\/lib\/uiMessages['"]\)/.test(bridgeApi)) {
  add(
    'lazy translation chunk contract',
    path.join(srcRoot, 'bridge', 'api.ts'),
    'GetTranslations no longer lazy-loads uiMessages',
  );
}

const mojibakeMarkerCodes = new Set([
  0x00c2, 0x00c3, 0x00d0, 0x00d1, 0x00d8, 0x00d9,
  0x00e0, 0x00e1, 0x00e2, 0x00ce, 0x00d5, 0x00d7,
]);
const mojibakeCp1252Bytes = new Map([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83],
  [0x201e, 0x84], [0x2026, 0x85], [0x2020, 0x86],
  [0x2021, 0x87], [0x02c6, 0x88], [0x2030, 0x89],
  [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c],
  [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92],
  [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95],
  [0x2013, 0x96], [0x2014, 0x97], [0x02dc, 0x98],
  [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b],
  [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f],
]);
function looksLikeRepairableMojibake(value) {
  let hasMarker = false;
  const bytes = [];
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (mojibakeMarkerCodes.has(code) || mojibakeCp1252Bytes.has(code)) {
      hasMarker = true;
    }
    if (code <= 255) {
      bytes.push(code);
    } else if (mojibakeCp1252Bytes.has(code)) {
      bytes.push(mojibakeCp1252Bytes.get(code));
    } else {
      return false;
    }
  }
  if (!hasMarker) return false;
  try {
    return new TextDecoder('utf-8', {fatal: true}).decode(
      new Uint8Array(bytes),
    ) !== value;
  } catch {
    return false;
  }
}

for (const file of [
  path.join(srcRoot, 'lib', 'uiMessages.ts'),
  path.join(srcRoot, 'lib', 'translationExtras.ts'),
  path.join(srcRoot, 'lib', 'bootI18n.ts'),
]) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g)) {
    if (looksLikeRepairableMojibake(match[2])) {
      add(
        'translation mojibake literal',
        file,
        'repairable mojibake found in a string literal',
      );
      break;
    }
  }
}

const dropCapResetFiles = [
  path.join(srcRoot, 'styles', 'tg-bubbles.css'),
  path.join(srcRoot, 'styles', 'greenhaven-skin.css'),
  path.join(srcRoot, 'styles', 'greenhaven-square-system.css'),
];
for (const file of dropCapResetFiles) {
  const text = readFileSync(file, 'utf8');
  if (!/::first-letter[\s\S]{0,500}font-size:\s*inherit\s*!important/.test(text)) {
    add('drop-cap reset', file, 'missing ::first-letter font-size inherit reset');
  }
}

const squareSystemCssFile = path.join(
  srcRoot,
  'styles',
  'greenhaven-square-system.css',
);
const squareSystemCss = readFileSync(squareSystemCssFile, 'utf8');
for (const selector of [
  '.gh-control:focus-visible',
  '.title-menu__btn:focus-visible',
  '.cart-lib button:focus-visible',
  '.creator-page button:focus-visible',
  '.bubble-menu button:focus-visible',
]) {
  if (!squareSystemCss.includes(selector)) {
    add(
      'square UI focus-visible contract',
      squareSystemCssFile,
      `missing ${selector}`,
    );
  }
}
for (const [name, regex, detail] of [
  [
    'chat composer containment contract',
    /body\s+\.chat-stage\.gh-game-stage\s*\{[\s\S]*display:\s*flex\s*!important[\s\S]*flex-direction:\s*column\s*!important/,
    'chat-stage must be flex-column so optional banners cannot move composer rows',
  ],
  [
    'chat scroll root contract',
    /body\s+\.chat-stage\.gh-game-stage\s*>\s*\.message-flow\s*\{[\s\S]*flex:\s*1\s+1\s+auto\s*!important[\s\S]*overflow-y:\s*auto\s*!important/,
    'message-flow must stay the only growable scroll root',
  ],
  [
    'chat composer bottom row contract',
    /body\s+\.chat-stage\.gh-game-stage\s*>\s*\.action-dock\s*\{(?=[\s\S]*flex:\s*0\s+0\s+auto\s*!important)(?=[\s\S]*z-index:\s*34\s*!important)/,
    'action-dock must stay a non-scrolling bottom row',
  ],
  [
    'music widget composer clearance',
    /body\s+\.cartridge-music-control\s*\{[\s\S]*bottom:\s*calc\(86px\s*\+\s*env\(safe-area-inset-bottom,\s*0px\)\)\s*!important/,
    'music widget must sit above the composer, not on top of it',
  ],
]) {
  if (!regex.test(squareSystemCss)) {
    add(name, squareSystemCssFile, detail);
  }
}

const noStaticInlineStyleFiles = [
  path.join(srcRoot, 'components', 'MobileBlocker.tsx'),
  path.join(srcRoot, 'components', 'npc', 'PartnerSwitch.tsx'),
  path.join(srcRoot, 'components', 'npc', 'NearbyNPCsRail.tsx'),
  path.join(srcRoot, 'components', 'npc', 'NPCCard.tsx'),
  path.join(srcRoot, 'components', 'rail', 'ChatList.tsx'),
  path.join(srcRoot, 'components', 'rail', 'PlayerStateRail.tsx'),
  path.join(srcRoot, 'components', 'rail', 'CurrencyBadge.tsx'),
  path.join(srcRoot, 'components', 'chat', 'EventCardAdventure.tsx'),
  path.join(srcRoot, 'components', 'chat', 'EventCardQuest.tsx'),
  path.join(srcRoot, 'components', 'chat', 'EventCardScene.tsx'),
  path.join(srcRoot, 'components', 'chat', 'EventCardSystem.tsx'),
  path.join(srcRoot, 'components', 'chat', 'EventCardWorld.tsx'),
  path.join(srcRoot, 'components', 'banners', 'InspirationBadge.tsx'),
  path.join(srcRoot, 'components', 'choice', 'WeightedChoice.tsx'),
  path.join(srcRoot, 'components', 'dice', 'LiveDiceOverlay.tsx'),
  path.join(srcRoot, 'components', 'loading', 'InspirationalQuote.tsx'),
  path.join(srcRoot, 'components', 'scene', 'SceneSurfaceStrip.tsx'),
];
for (const file of noStaticInlineStyleFiles) {
  const text = readFileSync(file, 'utf8');
  if (/style=\{\{/.test(text)) {
    add(
      'static inline style cleanup',
      file,
      'layout/static styles should stay in greenhaven-square-system.css',
    );
  }
}

const inlineStyleAllowlist = new Map([
  ['src/components/atmosphere/Atmosphere.tsx', 1],
  ['src/components/chat/ChatComposer.tsx', 1],
  ['src/components/chat/ChatSkeleton.tsx', 1],
  ['src/components/chat/NpcRevealCard.tsx', 2],
  ['src/components/cursor/MagneticCursor.tsx', 1],
  ['src/components/dice/DiceBox3D.tsx', 1],
  ['src/components/map/CityMapModal.tsx', 1],
  ['src/components/npc/Portrait.tsx', 5],
  ['src/components/rail/HeroVitals.tsx', 2],
  ['src/components/surfaces/CharacterStateSurface.tsx', 2],
  ['src/components/surfaces/RelationshipsSurface.tsx', 4],
  ['src/components/ui/progress.tsx', 1],
]);
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const count = (text.match(/style=\{\{/g) ?? []).length;
  if (count === 0) continue;
  const fileRel = rel(file);
  const allowed = inlineStyleAllowlist.get(fileRel);
  if (allowed == null) {
    add(
      'inline style allowlist',
      file,
      'new inline style site must be moved to CSS or explicitly justified',
    );
    continue;
  }
  if (count > allowed) {
    add(
      'inline style allowlist',
      file,
      `expected <= ${allowed} inline style sites, found ${count}`,
    );
  }
}

if (blockers.length > 0) {
  console.error(JSON.stringify({ok: false, blockers}, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ok: true, filesChecked: files.length}));
