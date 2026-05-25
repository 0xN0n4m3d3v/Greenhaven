/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-5 — debug-smoke specialist registration (side-effect import).
//
// Imports this module register the `/api/debug/verify-specialists`
// roster into the singleton in `./registry.js`. `DebugService.run`
// reads back `listDebugSmokeSpecialists()` to build the
// `VerifyTest[]` array for the current player, replacing the
// previously hardcoded matrix in `services/DebugService.ts`.
//
// Registration order MUST equal the previous matrix order so the
// route-level `verdicts.sort((a, b) => a.spec - b.spec)` stays a
// no-op for unchanged input. Spec numbers and names mirror the
// Greenhaven specification documents in `critique-report/`.

import {registerDebugSmokeSpecialist} from './registry.js';

registerDebugSmokeSpecialist({
  spec: 39,
  phase: 'debugSmoke',
  name: 'quest_watcher',
  endpoint: '/api/debug/run-quest-watcher',
  buildBody(playerId) {
    return {playerId, forceLLM: true};
  },
  check(p) {
    return p['watcher_ran'] === true
      ? {status: 'pass', notes: 'watcher_ran=true'}
      : {
          status: 'fail',
          notes: `unexpected: ${JSON.stringify(p).slice(0, 200)}`,
        };
  },
});

registerDebugSmokeSpecialist({
  spec: 40,
  phase: 'debugSmoke',
  name: 'combat_director',
  endpoint: '/api/debug/run-combat-director',
  buildBody(playerId) {
    return {
      playerProse:
        'I swing my longsword at @Mikka with full force, aiming for her ribs.',
      targetName: 'Mikka Quickgrin',
      playerId,
    };
  },
  check(p) {
    const brief = p['brief'] as Record<string, unknown> | undefined;
    if (!brief) {
      return {status: 'fail', notes: 'no brief returned (LLM fail-open)'};
    }
    if (brief['damage_plan'] && brief['position'] && brief['effect']) {
      return {
        status: 'pass',
        notes: 'damage_plan + position + effect present',
      };
    }
    return {status: 'fail', notes: 'brief missing required fields'};
  },
});

registerDebugSmokeSpecialist({
  spec: 41,
  phase: 'debugSmoke',
  name: 'intimacy_coordinator',
  endpoint: '/api/debug/run-intimacy-coordinator',
  buildBody(playerId) {
    return {
      playerProse: 'I lean in and kiss her, slow.',
      partnerName: 'Mikka Quickgrin',
      playerId,
    };
  },
  check(p) {
    const brief = p['brief'] as Record<string, unknown> | undefined;
    if (!brief) return {status: 'fail', notes: 'no brief'};
    if (
      brief['phase'] &&
      brief['quest_strategy'] &&
      Array.isArray(brief['tool_plan'])
    ) {
      return {
        status: 'pass',
        notes: `phase=${brief['phase']}, strategy=${brief['quest_strategy']}`,
      };
    }
    return {status: 'fail', notes: 'brief missing FSM fields'};
  },
});

registerDebugSmokeSpecialist({
  spec: 42,
  phase: 'debugSmoke',
  name: 'catalogue_scout',
  endpoint: '/api/debug/run-catalogue-scout',
  buildBody() {
    return {
      newEntities: [
        {id: 999_999_001, kind: 'person', display_name: 'Bartender'},
      ],
    };
  },
  check(p) {
    if (Array.isArray(p['verdicts'])) {
      return {
        status: 'pass',
        notes: `verdicts=${(p['verdicts'] as Array<unknown>).length}`,
      };
    }
    return {status: 'fail', notes: 'no verdicts array'};
  },
});

registerDebugSmokeSpecialist({
  spec: 43,
  phase: 'debugSmoke',
  name: 'npc_voice',
  endpoint: '/api/debug/run-npc-voice',
  buildBody() {
    return {memoryId: 0, force: true};
  },
  check(p) {
    if ('voiced' in p) {
      return {
        status: 'pass',
        notes: `voiced=${p['voiced']}, reason=${p['reason'] ?? '<n/a>'}`,
      };
    }
    return {status: 'fail', notes: 'no voiced flag'};
  },
});

registerDebugSmokeSpecialist({
  spec: 44,
  phase: 'debugSmoke',
  name: 'scene_painter',
  endpoint: '/api/debug/run-scene-painter',
  buildBody() {
    return {
      playerText: 'I look around.',
      sceneSummary: 'A warm evening on @Quickgrin Lane.',
      locationSummary: 'A narrow market lane.',
      language: 'en',
    };
  },
  check(p) {
    if (p['painter'] === true) {
      return {status: 'pass', notes: 'painter ran (text streamed)'};
    }
    if (p['painter'] === false) {
      return {
        status: 'fail',
        notes: `painter init failed: ${p['error']}`,
      };
    }
    return {status: 'fail', notes: 'unexpected response shape'};
  },
});

registerDebugSmokeSpecialist({
  spec: 45,
  phase: 'debugSmoke',
  name: 'dialogue_anchor',
  endpoint: '/api/debug/run-dialogue-anchor',
  buildBody(playerId) {
    return {playerId};
  },
  check(p) {
    if (p['anchor_ran'] === true) {
      return {status: 'pass', notes: 'anchor produced a brief'};
    }
    return {
      status: 'skipped',
      notes: 'anchor_ran=false (likely no active dialogue partner)',
    };
  },
});

registerDebugSmokeSpecialist({
  spec: 46,
  phase: 'debugSmoke',
  name: 'movement_warden',
  endpoint: '/api/debug/run-movement-warden',
  buildBody(playerId) {
    return {
      playerId,
      narrateText:
        'You suddenly find yourself at @Lantern Service Cellar. The air is dank.',
      currentLocationId: 1,
    };
  },
  check(p) {
    if ('teleport_detected' in p) {
      return {
        status: 'pass',
        notes: `teleport_detected=${p['teleport_detected']}`,
      };
    }
    return {status: 'fail', notes: 'no teleport_detected flag'};
  },
});

registerDebugSmokeSpecialist({
  spec: 47,
  phase: 'debugSmoke',
  name: 'reward_calibrator',
  endpoint: '/api/debug/run-reward-calibrator',
  buildBody(playerId) {
    return {
      playerId,
      playerText:
        "I refuse the captain's gold and walk into the alley alone.",
      mode: 'exploration',
    };
  },
  check(p) {
    if (
      p['calibrator_ran'] === true &&
      typeof p['briefing'] === 'string'
    ) {
      return {status: 'pass', notes: 'briefing returned'};
    }
    return {
      status: 'skipped',
      notes:
        'calibrator did not produce briefing (LLM fail-open or no player)',
    };
  },
});

registerDebugSmokeSpecialist({
  spec: 48,
  phase: 'debugSmoke',
  name: 'cartridge_steward',
  endpoint: '/api/debug/run-cartridge-steward',
  buildBody(playerId) {
    return {
      tool: 'create_entity',
      args: {
        kind: 'location',
        display_name: 'Steward Missing Summary Probe',
      },
      playerId,
    };
  },
  check(p) {
    const result = p['result'] as Record<string, unknown> | undefined;
    if (!result) return {status: 'fail', notes: 'no result'};
    if (result['rejected'] === true || result['ok'] === false) {
      return {
        status: 'pass',
        notes: `rejected/error: ${result['error']}`,
      };
    }
    return {
      status: 'fail',
      notes: 'expected rejection but got ok=true',
    };
  },
});

registerDebugSmokeSpecialist({
  spec: 49,
  phase: 'debugSmoke',
  name: 'quest_pacer',
  endpoint: '/api/debug/run-quest-pacer',
  buildBody(playerId) {
    return {playerId};
  },
  check(p) {
    if (p['pacer_ran'] === true) {
      return {
        status: 'pass',
        notes: `persisted=${p['persisted'] != null ? 'yes' : 'none'}`,
      };
    }
    return {status: 'fail', notes: 'pacer_ran=false'};
  },
});
