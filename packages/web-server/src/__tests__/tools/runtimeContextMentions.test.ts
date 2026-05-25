/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  enforceCanonicalMentionText,
  scanMentions,
  type MentionEntity,
} from '../../tools/runtimeContext.js';

const ENTITIES: MentionEntity[] = [
  {id: 1, kind: 'person', display_name: 'Tamara Vey'},
  {id: 2, kind: 'person', display_name: 'Bram Caskbright'},
  {id: 3, kind: 'location', display_name: 'Greenhaven Port'},
];

describe('runtime canonical mentions', () => {
  it('matches only canonical display_name tokens', () => {
    const text =
      'At @Greenhaven Port, @Tamara Vey sees Tamara Vey and @Тамара Вей.';

    expect(scanMentions(text, ENTITIES)).toEqual([
      {id: 1, kind: 'person', name: 'Tamara Vey'},
      {id: 3, kind: 'location', name: 'Greenhaven Port'},
    ]);
  });

  it('dearms non-canonical @ tokens without alias maps', () => {
    const repaired = enforceCanonicalMentionText(
      '@Тамара Вей waits beside @Tamara Vey while @Unknown Person waves.',
      ENTITIES,
    );

    expect(repaired.changed).toBe(true);
    expect(repaired.dearmedCount).toBe(2);
    expect(repaired.text).toBe(
      'Тамара Вей waits beside @Tamara Vey while Unknown Person waves.',
    );
  });
});

