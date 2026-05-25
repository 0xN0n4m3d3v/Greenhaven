/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { config } from '../config.js';

export const HARNESS_NAMES = {
  lane: 'GH Harness Lane',
  basement: 'GH Harness Basement',
  mikka: 'GH Harness Mikka',
  giver: 'GH Harness Giver',
  player: 'GH Harness Player',
  quest: 'GH Harness Stale Quest',
} as const;

export type SpecialistHarnessName =
  | 'voice_warden'
  | 'movement_warden'
  | 'cartridge_steward'
  | 'quest_watcher'
  | 'quest_pacer'
  | 'protagonist_action_renderer'
  | 'adventure_materializer';

export type HarnessExpectation =
  | { kind: 'tool_rejected'; errorIncludes?: string }
  | { kind: 'tool_accepted' }
  | { kind: 'quest_signal'; signalType: string }
  | {
      kind: 'protagonist_render';
      changed: boolean;
      visibleIncludes?: string;
      skippedReasonIncludes?: string;
    };

export interface SpecialistFixture {
  id: string;
  specialist: SpecialistHarnessName;
  description: string;
  requiresProvider: boolean;
  input: unknown;
  expected: HarnessExpectation;
}

export const SPECIALIST_FIXTURES: SpecialistFixture[] = [
  {
    id: 'voice_accept_npc',
    specialist: 'voice_warden',
    description: 'NPC first-person speech under the NPC author should pass.',
    requiresProvider: true,
    input: {
      toolName: 'narrate',
      args: {
        author: HARNESS_NAMES.mikka,
        tone: 'npc',
        text: 'I lean across the counter and lower my voice. The rumor is real, but I do not sell palace secrets cheaply. Bring coin, courage, or a better question.',
        done: true,
      },
    },
    expected: { kind: 'tool_accepted' },
  },
  {
    id: 'voice_reject_dialogue_under_location',
    specialist: 'voice_warden',
    description: 'Direct NPC dialogue under a location author should reject.',
    requiresProvider: true,
    input: {
      toolName: 'narrate',
      args: {
        author: HARNESS_NAMES.lane,
        tone: 'narrator',
        text: 'Mikka Quickgrin leans across the stall. "Listen close. I can sell you the palace rumor, but not for free." Her grin sharpens as she taps the counter twice.',
        done: true,
      },
    },
    expected: { kind: 'tool_rejected', errorIncludes: 'voice/author mismatch' },
  },
  {
    id: 'voice_reject_scene_under_npc',
    specialist: 'voice_warden',
    description: 'Pure scene framing under an NPC author should reject.',
    requiresProvider: true,
    input: {
      toolName: 'narrate',
      args: {
        author: HARNESS_NAMES.mikka,
        tone: 'npc',
        text: 'The lane narrows around you as rain gathers in the cracked stones. Lantern smoke bends low over the stalls, and you notice a locked cellar door beneath the awning.',
        done: true,
      },
    },
    expected: { kind: 'tool_rejected', errorIncludes: 'voice/author mismatch' },
  },
  {
    id: 'voice_multilingual_reject',
    specialist: 'voice_warden',
    description: 'Spanish dialogue under a location author should reject.',
    requiresProvider: true,
    input: {
      toolName: 'narrate',
      args: {
        author: HARNESS_NAMES.lane,
        tone: 'narrator',
        text: 'Mikka Quickgrin cruza los brazos. "Escucha, viajero. No vendo secretos baratos." La mercader sonrie y espera tu respuesta con paciencia peligrosa.',
        done: true,
      },
    },
    expected: { kind: 'tool_rejected', errorIncludes: 'voice/author mismatch' },
  },
  {
    id: 'movement_reject_teleport',
    specialist: 'movement_warden',
    description:
      'Narration placing the player at another @location should reject.',
    requiresProvider: true,
    input: {
      toolName: 'narrate',
      args: {
        author: HARNESS_NAMES.lane,
        tone: 'narrator',
        text: 'You wake up inside @GH Harness Basement. The stone ceiling drips above you, and the market noise is suddenly far away behind a locked trapdoor.',
        done: true,
      },
    },
    expected: {
      kind: 'tool_rejected',
      errorIncludes: 'narrator teleport blocked',
    },
  },
  {
    id: 'cartridge_reject_duplicate_location',
    specialist: 'cartridge_steward',
    description: 'Duplicate location creation should reject before mutation.',
    requiresProvider: false,
    input: {
      toolName: 'create_entity',
      args: {
        kind: 'location',
        display_name: HARNESS_NAMES.lane,
        summary: 'A duplicate copy of the harness lane.',
      },
    },
    expected: { kind: 'tool_rejected', errorIncludes: 'near-duplicate' },
  },
  {
    id: 'quest_watcher_provider_smoke',
    specialist: 'quest_watcher',
    description:
      'Provider-backed Quest Watcher fixture should run against a staged quest without crashing.',
    requiresProvider: true,
    input: {
      text: 'I open the old latch and step through the cellar door.',
      narrative:
        'The old latch gives way and the cellar door opens. The next route is clear.',
    },
    expected: { kind: 'tool_accepted' },
  },
  {
    id: 'quest_pacer_dead_arc',
    specialist: 'quest_pacer',
    description:
      'Stale quest with absent giver should produce a dead_npc_arc signal.',
    requiresProvider: false,
    input: {},
    expected: { kind: 'quest_signal', signalType: 'dead_npc_arc' },
  },
  {
    id: 'protagonist_render_preserves_intent',
    specialist: 'protagonist_action_renderer',
    description:
      'Validation accepts a hero-bubble render that preserves mentions, speech, and dice.',
    requiresProvider: false,
    input: {
      rawText: 'I take @Mikka by the hand and say "Stay with me." [[1d20+2]]',
      candidate: {
        mode: 'render',
        changed: true,
        rendered_text:
          'I take @Mikka by the hand and say "Stay with me." [[1d20+2]], keeping my voice low and steady.',
        intent_summary: 'Player takes Mikka by the hand and speaks.',
        meaning_delta: 'none',
        preserved_elements: {
          actor: 'player_hero',
          targets: ['Mikka'],
          actions: ['take by the hand', 'say'],
          direct_speech: ['"Stay with me."'],
          mechanical_tokens: ['[[1d20+2]]'],
        },
        confidence: 0.92,
        skipped_reason: null,
      },
      knownMentionNames: ['Mikka'],
    },
    expected: {
      kind: 'protagonist_render',
      changed: true,
      visibleIncludes: '@Mikka',
    },
  },
  {
    id: 'protagonist_render_rejects_drift',
    specialist: 'protagonist_action_renderer',
    description:
      'Validation rejects a render that drops the target mention or changes meaning.',
    requiresProvider: false,
    input: {
      rawText: 'I do not take @Mikka by the hand and say "Stay with me."',
      candidate: {
        mode: 'render',
        changed: true,
        rendered_text: 'I take her hand and say "Stay with me."',
        intent_summary: 'Bad fixture intentionally drops negation and mention.',
        meaning_delta: 'changed',
        preserved_elements: {
          actor: 'player_hero',
          targets: [],
          actions: ['take hand'],
          direct_speech: ['"Stay with me."'],
          mechanical_tokens: [],
        },
        confidence: 0.9,
        skipped_reason: null,
      },
      knownMentionNames: ['Mikka'],
    },
    expected: {
      kind: 'protagonist_render',
      changed: false,
      skippedReasonIncludes: 'meaning_delta',
    },
  },
  {
    id: 'adventure_materializer_hidden_location',
    specialist: 'adventure_materializer',
    description:
      'Provider-backed Adventure Materializer should turn a queued hidden_location opportunity into a ready blueprint.',
    requiresProvider: true,
    input: {
      adventureKind: 'hidden_location',
      text: 'I follow the half-hidden marker toward the old wall.',
      narrative:
        'A faint marker catches the light near the old wall, suggesting a place just outside the known route.',
    },
    expected: { kind: 'tool_accepted' },
  },
];

export function fixturesFor(
  specialist: SpecialistHarnessName,
): SpecialistFixture[] {
  return SPECIALIST_FIXTURES.filter((f) => f.specialist === specialist);
}

export function fixtureById(id: string): SpecialistFixture | undefined {
  return SPECIALIST_FIXTURES.find((f) => f.id === id);
}

export function hasProviderKeys(): boolean {
  return Boolean(config().deepseekApiKey || config().featherlessApiKey);
}
