import { describe, expect, it } from 'vitest';
import { activeCartridgeEntityPredicate } from '../cartridgeScope.js';

describe('activeCartridgeEntityPredicate (ARCH-19 Phase 3 / ARCH-8)', () => {
  it('reads from the normalized columns only', () => {
    const predicate = activeCartridgeEntityPredicate('e', '$1');
    expect(predicate).toContain('e.cartridge_id = $1');
    expect(predicate).toContain('e.dynamic_origin = true');
    expect(predicate).toContain("e.kind = 'player'");
  });

  it('does not consult the JSONB profile or legacy tags', () => {
    const predicate = activeCartridgeEntityPredicate('e', '$1');
    expect(predicate).not.toMatch(/profile->>/);
    expect(predicate).not.toMatch(/profile \?/);
    expect(predicate).not.toMatch(/= ANY\(e\.tags\)/);
    expect(predicate).not.toContain("'dynamic'");
    expect(predicate).not.toContain("'support-smoke'");
    expect(predicate).not.toContain("'quickgrin-lane'");
  });

  it('uses the supplied alias and cartridge parameter without mutation', () => {
    const predicate = activeCartridgeEntityPredicate('child', '$cartridge');
    expect(predicate).toContain('child.cartridge_id = $cartridge');
    expect(predicate).toContain('child.dynamic_origin = true');
    expect(predicate).toContain("child.kind = 'player'");
    expect(predicate).not.toContain('e.');
    expect(predicate).not.toContain('$1');
  });
});
