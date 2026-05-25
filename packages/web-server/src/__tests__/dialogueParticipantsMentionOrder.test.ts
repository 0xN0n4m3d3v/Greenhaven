/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// DP-1 — `idsInMentionOrder` must select addressed NPC mentions
// with longest-match and word-boundary semantics. The previous
// implementation used a naive `text.indexOf('@' + name)` which
// (a) returned `Mikka` as a hit for `@Mikkael` (substring match)
// and (b) preferred the shortest alias whenever two cartridge
// entities shared a prefix.
//
// The tests below pin the contract: longest valid mention wins,
// substrings are rejected, punctuation/end-of-string boundaries
// count, repeated mentions of the same NPC dedupe, multiple
// distinct NPCs return in text order, and non-person mentions are
// ignored.

import {describe, expect, it} from 'vitest';
import {idsInMentionOrder} from '../dialogueParticipants.js';

type Mention = {id: number; name: string; kind: string};

const MIKKA: Mention = {id: 1, name: 'Mikka', kind: 'person'};
const MIKKAEL: Mention = {id: 2, name: 'Mikkael', kind: 'person'};
const MIKKA_THE_BOLD: Mention = {id: 3, name: 'Mikka the Bold', kind: 'person'};
const ALICE: Mention = {id: 10, name: 'Alice', kind: 'person'};
const BOB: Mention = {id: 11, name: 'Bob', kind: 'person'};
const GRINHAVEN: Mention = {id: 20, name: 'Grinhaven', kind: 'location'};

describe('idsInMentionOrder — DP-1', () => {
  it('prefers the longest valid mention when multiple names share a prefix span', () => {
    // `@Mikka the Bold` must resolve only to the long alias; the
    // bare `Mikka` shares the same span and must not also fire.
    const text = 'Hello @Mikka the Bold, how are you?';
    expect(idsInMentionOrder(text, [MIKKA, MIKKA_THE_BOLD])).toEqual([
      MIKKA_THE_BOLD.id,
    ]);
    // Order in the mentions array must not affect the outcome.
    expect(idsInMentionOrder(text, [MIKKA_THE_BOLD, MIKKA])).toEqual([
      MIKKA_THE_BOLD.id,
    ]);
  });

  it('rejects a substring match where the next character is a word continuation', () => {
    // `@Mikkael` must NOT match the shorter `Mikka` — the trailing
    // `e` is a token continuation, so the `@Mikka` candidate has
    // no valid boundary and must be discarded.
    const text = 'Please greet @Mikkael at the gate.';
    expect(idsInMentionOrder(text, [MIKKA, MIKKAEL])).toEqual([MIKKAEL.id]);
  });

  it('accepts ASCII punctuation boundaries after a mention', () => {
    const punctuations = ['.', '!', '?', ')', ',', ';', ':'];
    for (const punct of punctuations) {
      const text = `Tell @Mikka${punct} now.`;
      expect(idsInMentionOrder(text, [MIKKA])).toEqual([MIKKA.id]);
    }
  });

  it('accepts an end-of-string boundary', () => {
    const text = 'Goodbye @Mikka';
    expect(idsInMentionOrder(text, [MIKKA])).toEqual([MIKKA.id]);
  });

  it('dedupes when the same NPC is addressed twice and uses the earliest index', () => {
    const text = 'Hi @Mikka, did @Mikka see this?';
    expect(idsInMentionOrder(text, [MIKKA])).toEqual([MIKKA.id]);
  });

  it('returns multiple distinct NPCs in order of first appearance in text', () => {
    const aliceFirst = 'Quick word: @Alice, then @Bob.';
    expect(idsInMentionOrder(aliceFirst, [BOB, ALICE])).toEqual([
      ALICE.id,
      BOB.id,
    ]);

    const bobFirst = 'Quick word: @Bob, then @Alice.';
    expect(idsInMentionOrder(bobFirst, [ALICE, BOB])).toEqual([
      BOB.id,
      ALICE.id,
    ]);
  });

  it('ignores non-person mentions even when their @name is present', () => {
    // A location alias must never join the dialogue participant list,
    // even if the player typed `@Grinhaven` alongside a real person.
    const text = 'Meet me at @Grinhaven with @Alice.';
    expect(idsInMentionOrder(text, [GRINHAVEN, ALICE])).toEqual([ALICE.id]);
  });

  it('rejects word-continuation suffixes that include underscores or digits', () => {
    // `_` and digits both count as token continuations, so
    // `@Mikka_x` and `@Mikka1` must not surface the bare `Mikka`
    // unless an alias literally matching that longer form exists.
    expect(idsInMentionOrder('Ping @Mikka_x now.', [MIKKA])).toEqual([]);
    expect(idsInMentionOrder('Ping @Mikka1 now.', [MIKKA])).toEqual([]);
  });
});
