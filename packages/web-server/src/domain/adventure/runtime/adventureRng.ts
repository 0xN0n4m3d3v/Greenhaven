/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {createHash} from 'node:crypto';

export interface DeterministicRoll {
  die: string;
  raw: number;
  roll: number;
}

export interface WeightedCandidate {
  kind: string;
  weight: number;
}

export interface WeightedSelection<T extends WeightedCandidate> {
  selected: T;
  totalWeight: number;
  roll: DeterministicRoll;
  candidates: Array<T & {rangeStart: number; rangeEnd: number}>;
}

export function rollDie(seed: string, sequence: number, sides: number): DeterministicRoll {
  if (!Number.isInteger(sequence) || sequence < 0) {
    throw new Error(`invalid deterministic sequence: ${sequence}`);
  }
  if (!Number.isInteger(sides) || sides < 1) {
    throw new Error(`invalid deterministic die sides: ${sides}`);
  }
  const hash = createHash('sha256')
    .update(`${seed}|${sequence}|d${sides}`)
    .digest();
  const raw = hash.readUInt32BE(0) & 0x7fffffff;
  return {
    die: `d${sides}`,
    raw,
    roll: (raw % sides) + 1,
  };
}

export function selectWeighted<T extends WeightedCandidate>(opts: {
  seed: string;
  sequence: number;
  candidates: T[];
}): WeightedSelection<T> {
  const candidates = opts.candidates.filter(candidate => {
    return Number.isFinite(candidate.weight) && candidate.weight > 0;
  });
  if (candidates.length === 0) {
    throw new Error('weighted selection has no positive-weight candidates');
  }

  const totalWeight = candidates.reduce(
    (total, candidate) => total + Math.trunc(candidate.weight),
    0,
  );
  if (totalWeight <= 0) {
    throw new Error('weighted selection total weight is not positive');
  }

  const roll = rollDie(opts.seed, opts.sequence, totalWeight);
  let cursor = 0;
  const ranged = candidates.map(candidate => {
    const weight = Math.trunc(candidate.weight);
    const rangeStart = cursor + 1;
    cursor += weight;
    return {...candidate, rangeStart, rangeEnd: cursor};
  });
  const selected =
    ranged.find(candidate => roll.roll >= candidate.rangeStart && roll.roll <= candidate.rangeEnd) ??
    ranged[ranged.length - 1]!;

  return {
    selected,
    totalWeight,
    roll,
    candidates: ranged,
  };
}

export function stableSeed(parts: Array<string | number | null | undefined>): string {
  return parts
    .map(part => (part == null ? 'null' : String(part)))
    .join('|');
}
