import {describe, expect, it} from 'vitest';
import {extractMentionsAnyScript} from '../../agents/movementWarden.js';

function names(text: string): string[] {
  return [...extractMentionsAnyScript(text).keys()];
}

describe('extractMentionsAnyScript', () => {
  it('keeps multi-word location candidates for runtime @mentions', () => {
    expect(names('Ты оказываешься в @Town square.')).toContain('Town square');
    expect(names("The hatch opens toward @Thief's market.")).toContain(
      "Thief's market",
    );
    expect(names("What's the gossip about @The Docks lately?")).toContain(
      'The Docks',
    );
  });

  it('keeps multiple adjacent person mentions in orderable form', () => {
    const found = names('@Mikka Quickgrin @Borek сверим реальность.');
    expect(found).toContain('Mikka Quickgrin');
    expect(found).toContain('Borek');
  });
});
