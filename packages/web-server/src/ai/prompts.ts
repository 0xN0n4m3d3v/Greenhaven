/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Role-scoped prompt loader.
//
// The common Greenhaven contract intentionally contains no gameplay-tool
// examples. Mechanical tool rules live in broker fragments; visible prose rules
// live in narrator/painter prompts. Broker fragments are assembled by manifest
// so each runtime mode receives a narrow contract instead of a catch-all prompt.

import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

type PromptName = 'common' | 'narrator';
export type BrokerPromptProfile =
  | 'adventure_accept'
  | 'adventure_ignore'
  | 'commerce_bargain'
  | 'commerce_social'
  | 'default'
  | 'environment_probe'
  | 'intimacy_social'
  | 'quest_detail'
  | 'quest_seed'
  | 'scene_trade'
  | 'state_recap'
  | 'movement_social';

const cache = new Map<PromptName, string>();
const brokerFragmentCache = new Map<string, string>();
const computedBrokerCache = new Map<string, string>();

const BROKER_BASE_FRAGMENTS = [
  '00-header.md',
  'identity.md',
  'language.md',
  'entity-spawn-mentions.md',
  'voice-authoring.md',
  'player-agency.md',
  'cartridge-tone.md',
  'prose-style.md',
  'internal-analysis.md',
  'final-voice.md',
  'world.md',
  'grounded-action-sources.md',
  'active-player-identity.md',
  'turn-context.md',
  'location-memory.md',
  'tools-mandatory.md',
  'player-actions.md',
  'movement.md',
  'companions.md',
  // 'companions.md' is loaded conditionally — only when the player
  // actually has at least one active companion. See
  // loadBrokerPromptForMode(..., context) below.
  'player-identity-preamble.md',
  'ability-checks.md',
  'gamemaster-affordances.md',
  'mentions.md',
] as const;

const BROKER_NARROW_PROFILE_BASE_FRAGMENTS = [
  '00-header.md',
  'identity.md',
  'language.md',
  'voice-authoring.md',
  'player-agency.md',
  'cartridge-tone.md',
  'prose-style.md',
  'internal-analysis.md',
  'final-voice.md',
  'world.md',
  'grounded-action-sources.md',
  'active-player-identity.md',
  'turn-context.md',
  'location-memory.md',
  'tools-narrow.md',
  'movement.md',
  'companions.md',
  'ability-checks.md',
  'gamemaster-affordances-compact.md',
  'mentions-compact.md',
] as const;

// memory.md AND state-canonization.md are loaded in every mode. Both
// describe REQUIRED tool calls (write a memory; canonize a state change)
// that the broker silently skips when these fragments are absent —
// resulting in NPC amnesia and inter-NPC narrative drift respectively.
// They are independent contracts: memory.md is about what the speaking
// NPC remembers; state-canonization.md is about what the WORLD records.
const ALWAYS_LOAD_FRAGMENTS = [
  'memory.md',
  'state-canonization.md',
  'entity-creation-discipline.md',
] as const;

const BROKER_MODE_FRAGMENTS = {
  combat: [
    'combat.md',
    'position-effect.md',
    'combat-conditions.md',
    'devils-bargain.md',
    'trauma.md',
    'surfaces.md',
    ...ALWAYS_LOAD_FRAGMENTS,
  ],
  intimacy: [
    'intimacy.md',
    'strings.md',
    'devils-bargain.md',
    'sex-moves.md',
    'quest-mechanics.md',
    'quest-narrative.md',
    ...ALWAYS_LOAD_FRAGMENTS,
    'inspiration.md',
  ],
  dialogue: [
    'dynamic-quests.md',
    ...ALWAYS_LOAD_FRAGMENTS,
    'strings.md',
    'quest-mechanics.md',
    'quest-narrative.md',
    'inspiration.md',
  ],
  exploration: [
    'dynamic-quests.md',
    'quest-narrative.md',
    'surfaces.md',
    'inspiration.md',
    ...ALWAYS_LOAD_FRAGMENTS,
  ],
  travel: [
    'dynamic-quests.md',
    'quest-narrative.md',
    'surfaces.md',
    'inspiration.md',
    ...ALWAYS_LOAD_FRAGMENTS,
  ],
  rest: [
    'dynamic-quests.md',
    'quest-narrative.md',
    'surfaces.md',
    'inspiration.md',
    ...ALWAYS_LOAD_FRAGMENTS,
  ],
} as const;

const BROKER_PROFILE_MODE_FRAGMENTS = {
  movement_social: {
    exploration: ['movement.md', 'companions.md'],
    travel: ['movement.md', 'companions.md'],
  },
  environment_probe: {
    exploration: ['movement.md', 'companions.md', 'surfaces.md'],
    travel: ['movement.md', 'companions.md', 'surfaces.md'],
  },
  commerce_social: {
    dialogue: ['commerce.md'],
    exploration: ['commerce.md'],
    travel: ['commerce.md'],
  },
  commerce_bargain: {
    combat: ['commerce-bargain.md'],
    dialogue: ['commerce-bargain.md'],
    exploration: ['commerce-bargain.md'],
    travel: ['commerce-bargain.md'],
  },
  scene_trade: {
    dialogue: ['scene-trade.md'],
    exploration: ['scene-trade.md'],
    travel: ['scene-trade.md'],
  },
  quest_seed: {
    dialogue: ['quest-seed.md'],
    exploration: ['quest-seed.md'],
    travel: ['quest-seed.md'],
  },
  quest_detail: {
    dialogue: ['quest-detail.md'],
    exploration: ['quest-detail.md'],
    travel: ['quest-detail.md'],
  },
  adventure_accept: {
    dialogue: ['adventure-accept.md'],
    exploration: ['adventure-accept.md'],
    travel: ['adventure-accept.md'],
  },
  adventure_ignore: {
    dialogue: ['adventure-ignore.md'],
    exploration: ['adventure-ignore.md'],
    travel: ['adventure-ignore.md'],
  },
  intimacy_social: {
    intimacy: ['intimacy-beat.md'],
  },
  state_recap: {
    dialogue: ['state-recap.md'],
    exploration: ['state-recap.md'],
    travel: ['state-recap.md'],
  },
} as const;

export const BROKER_PROMPT_FRAGMENT_MANIFEST = {
  base: BROKER_BASE_FRAGMENTS,
  narrowBase: BROKER_NARROW_PROFILE_BASE_FRAGMENTS,
  modes: BROKER_MODE_FRAGMENTS,
  profiles: BROKER_PROFILE_MODE_FRAGMENTS,
} as const;

function promptPath(fileName: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'prompts', fileName);
}

function loadPrompt(name: PromptName, fileName: string): string {
  const cached = cache.get(name);
  if (cached) return cached;
  const text = readFileSync(promptPath(fileName), 'utf-8').trim();
  cache.set(name, text);
  return text;
}

export function loadCommonPrompt(): string {
  return loadPrompt('common', 'greenhaven.md');
}

export function loadBrokerPrompt(): string {
  const all = [
    ...BROKER_BASE_FRAGMENTS,
    ...BROKER_MODE_FRAGMENTS.combat,
    ...BROKER_MODE_FRAGMENTS.intimacy,
    ...BROKER_MODE_FRAGMENTS.dialogue,
    ...BROKER_MODE_FRAGMENTS.exploration,
  ];
  return assembleBrokerPrompt(uniqueFragments(all));
}

export interface BrokerPromptContext {
  /** Player currently has at least one active companion NPC. When true,
   *  the `companions.md` fragment is appended — it describes the
   *  set_companion lifecycle, in-party tool chains, and splitting/
   *  rejoining recipes. When false the fragment is omitted to keep the
   *  prompt budget tight. */
  hasCompanion?: boolean;
}

export function loadBrokerPromptForMode(
  mode: string,
  profile: BrokerPromptProfile = 'default',
  context: BrokerPromptContext = {},
): string {
  const ctxKey = context.hasCompanion ? 'c1' : 'c0';
  const key = `${mode || 'exploration'}:${profile}:${ctxKey}`;
  const cached = computedBrokerCache.get(key);
  if (cached) return cached;

  const compiled = assembleBrokerPrompt(
    brokerPromptFragmentFilesForMode(mode, profile, context),
  );
  computedBrokerCache.set(key, compiled);
  return compiled;
}

export function brokerPromptFragmentFilesForMode(
  mode: string,
  profile: BrokerPromptProfile = 'default',
  context: BrokerPromptContext = {},
): readonly string[] {
  const modeKey = isBrokerMode(mode) ? mode : 'exploration';
  const profileFragments = brokerProfileFragmentsForMode(modeKey, profile);
  const base = profileFragments
    ? [...brokerBaseFragmentsForProfile(profile), ...profileFragments]
    : [...BROKER_BASE_FRAGMENTS, ...BROKER_MODE_FRAGMENTS[modeKey]];
  // Conditional fragments: append AFTER the mode fragments so they
  // surface near the end of the prompt (more salient to the model).
  const conditional: string[] = [];
  if (context.hasCompanion) conditional.push('companions.md');
  return uniqueFragments([...base, ...conditional]);
}

function brokerBaseFragmentsForProfile(
  profile: BrokerPromptProfile,
): readonly string[] {
  if (
    profile === 'adventure_accept' ||
    profile === 'adventure_ignore' ||
    profile === 'commerce_social' ||
    profile === 'commerce_bargain' ||
    profile === 'environment_probe' ||
    profile === 'intimacy_social' ||
    profile === 'movement_social' ||
    profile === 'quest_detail' ||
    profile === 'quest_seed' ||
    profile === 'scene_trade' ||
    profile === 'state_recap'
  ) {
    return BROKER_NARROW_PROFILE_BASE_FRAGMENTS;
  }
  return BROKER_BASE_FRAGMENTS;
}

export function loadNarratorPrompt(): string {
  return [loadCommonPrompt(), loadPrompt('narrator', 'greenhaven.narrator.md')]
    .join('\n\n')
    .trim();
}

function assembleBrokerPrompt(files: readonly string[]): string {
  return files.map(loadBrokerFragment).filter(Boolean).join('\n\n').trim();
}

function loadBrokerFragment(fileName: string): string {
  const cached = brokerFragmentCache.get(fileName);
  if (cached) return cached;
  // Caveman compression: when GREENHAVEN_CAVEMAN_PROMPTS=1, prefer
  // the compressed .caveman.md variant (~60% fewer tokens) when it
  // exists. Falls back to original .md otherwise.
  const useCaveman = config().cavemanPrompts;
  const cavemanName = fileName.replace(/\.md$/, '.caveman.md');
  const loadPath = path.join(
    'broker',
    useCaveman && existsSync(promptPath(path.join('broker', cavemanName)))
      ? cavemanName
      : fileName,
  );
  const text = readFileSync(promptPath(loadPath), 'utf-8').trim();
  brokerFragmentCache.set(fileName, text);
  return text;
}

function uniqueFragments(files: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const file of files) {
    if (seen.has(file)) continue;
    seen.add(file);
    out.push(file);
  }
  return out;
}

function isBrokerMode(
  mode: string,
): mode is keyof typeof BROKER_MODE_FRAGMENTS {
  return Object.prototype.hasOwnProperty.call(BROKER_MODE_FRAGMENTS, mode);
}

function brokerProfileFragmentsForMode(
  mode: keyof typeof BROKER_MODE_FRAGMENTS,
  profile: BrokerPromptProfile,
): readonly string[] | null {
  if (profile === 'movement_social') {
    if (mode === 'exploration' || mode === 'travel') {
      return BROKER_PROFILE_MODE_FRAGMENTS.movement_social[mode];
    }
    return null;
  }
  if (profile === 'environment_probe') {
    if (mode === 'exploration' || mode === 'travel') {
      return BROKER_PROFILE_MODE_FRAGMENTS.environment_probe[mode];
    }
    return null;
  }
  if (profile === 'commerce_social') {
    if (mode === 'dialogue' || mode === 'exploration' || mode === 'travel') {
      return BROKER_PROFILE_MODE_FRAGMENTS.commerce_social[mode];
    }
    return null;
  }
  if (profile === 'commerce_bargain') {
    if (
      mode === 'combat' ||
      mode === 'dialogue' ||
      mode === 'exploration' ||
      mode === 'travel'
    ) {
      return BROKER_PROFILE_MODE_FRAGMENTS.commerce_bargain[mode];
    }
    return null;
  }
  if (profile === 'scene_trade') {
    if (mode === 'dialogue' || mode === 'exploration' || mode === 'travel') {
      return BROKER_PROFILE_MODE_FRAGMENTS.scene_trade[mode];
    }
    return null;
  }
  if (profile === 'quest_seed') {
    if (mode === 'dialogue' || mode === 'exploration' || mode === 'travel') {
      return BROKER_PROFILE_MODE_FRAGMENTS.quest_seed[mode];
    }
    return null;
  }
  if (profile === 'quest_detail') {
    if (mode === 'dialogue' || mode === 'exploration' || mode === 'travel') {
      return BROKER_PROFILE_MODE_FRAGMENTS.quest_detail[mode];
    }
    return null;
  }
  if (profile === 'adventure_accept') {
    if (mode === 'dialogue' || mode === 'exploration' || mode === 'travel') {
      return BROKER_PROFILE_MODE_FRAGMENTS.adventure_accept[mode];
    }
    return null;
  }
  if (profile === 'adventure_ignore') {
    if (mode === 'dialogue' || mode === 'exploration' || mode === 'travel') {
      return BROKER_PROFILE_MODE_FRAGMENTS.adventure_ignore[mode];
    }
    return null;
  }
  if (profile === 'intimacy_social') {
    if (mode === 'intimacy') {
      return BROKER_PROFILE_MODE_FRAGMENTS.intimacy_social[mode];
    }
    return null;
  }
  if (profile === 'state_recap') {
    if (mode === 'dialogue' || mode === 'exploration' || mode === 'travel') {
      return BROKER_PROFILE_MODE_FRAGMENTS.state_recap[mode];
    }
    return null;
  }
  return null;
}
