/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  type LocationMemoryPacket,
  renderLocationMemoryPacket,
} from '../../domain/memory/location/locationMemory.js';

function packet(
  overrides: Partial<LocationMemoryPacket> = {},
): LocationMemoryPacket {
  return {
    locationId: 42,
    locationName: 'Greenhaven Port',
    visitCount: 1,
    enteredThisTurn: true,
    introBubble: null,
    profileFrame: null,
    memories: [],
    ...overrides,
  };
}

describe('renderLocationMemoryPacket cartridge frame', () => {
  it('renders authored location profile fields into the turn context', () => {
    const rendered = renderLocationMemoryPacket(
      packet({
        profileFrame: {
          locationCanon: 'A bright harbor where three factions collide.',
          locationBrief: 'Start hub with visible trouble on the docks.',
          locationRules: 'Do not make the port empty or safe by default.',
          sensoryIdentity: 'Salt, citrus crates, hot tar, and brass bells.',
          visibleExitsProse: '@Main Square uphill; @Adventurers Guild east.',
          pointsOfInterest: 'Notice board, blue warehouse, customs booth.',
          immediatePlayerActions: 'Read the notice, speak to Tessa, inspect the hatch.',
          hostilePressure: 'Black-armband dockers watch newcomers too openly.',
          adventureThreat: 'Something scratches under the warehouse floor.',
          locationMemoryHooks: 'The port remembers who helped during public trouble.',
          publicScenesProse: 'Argument at customs; courier collapse; cellar breach.',
          companionStake: 'A nervous companion wants the open street kept in sight.',
        },
      }),
    );

    expect(rendered).toContain('Cartridge location frame:');
    expect(rendered).toContain(
      'Canon: A bright harbor where three factions collide.',
    );
    expect(rendered).toContain(
      'Immediate actions: Read the notice, speak to Tessa, inspect the hatch.',
    );
    expect(rendered).toContain(
      'Location rules: Do not make the port empty or safe by default.',
    );
    expect(rendered).toContain(
      'Frame directive: prefer this authored frame',
    );
  });

  it('omits the authored frame section when the location has no profile frame', () => {
    const rendered = renderLocationMemoryPacket(packet());

    expect(rendered).not.toContain('Cartridge location frame:');
    expect(rendered).toContain(
      'Local continuity: no durable local memories yet.',
    );
  });

  it('clips oversized authored fields before they enter the prompt', () => {
    const longText = `start ${'x'.repeat(1200)} end`;
    const rendered = renderLocationMemoryPacket(
      packet({
        profileFrame: {
          locationCanon: longText,
          locationBrief: null,
          locationRules: null,
          sensoryIdentity: null,
          visibleExitsProse: null,
          pointsOfInterest: null,
          immediatePlayerActions: null,
          hostilePressure: null,
          adventureThreat: null,
          locationMemoryHooks: null,
          publicScenesProse: null,
          companionStake: null,
        },
      }),
    );

    expect(rendered).toContain('Canon: start');
    expect(rendered).toContain('...');
    expect(rendered).not.toContain(' end');
  });
});
