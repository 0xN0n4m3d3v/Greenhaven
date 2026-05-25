/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-13 — `parseScriptedActionId` is the single source of truth for
// scripted action-id wire format. The router (`maybeScriptAction`) only
// dispatches. These tests cover the parser exhaustively because the
// router branches map 1:1 to the parser's discriminated union.

import {describe, expect, it} from 'vitest';
import {parseScriptedActionId} from '../scriptedActions/actionIds.js';

describe('parseScriptedActionId (ARCH-13)', () => {
  describe('social', () => {
    it('parses social:<npcId>:<checkKind>', () => {
      expect(parseScriptedActionId('social:200:seduce')).toEqual({
        kind: 'social',
        npcId: 200,
        checkKind: 'seduce',
      });
    });

    it('preserves the check-kind string verbatim (snake_case, hyphens, casing)', () => {
      expect(parseScriptedActionId('social:201:persuade_quiet')).toEqual({
        kind: 'social',
        npcId: 201,
        checkKind: 'persuade_quiet',
      });
      expect(parseScriptedActionId('social:202:STR-shove')).toEqual({
        kind: 'social',
        npcId: 202,
        checkKind: 'STR-shove',
      });
    });

    it('rejects zero / negative / non-integer npc ids', () => {
      expect(parseScriptedActionId('social:0:seduce')).toBeNull();
      expect(parseScriptedActionId('social:-1:seduce')).toBeNull();
      expect(parseScriptedActionId('social:3.5:seduce')).toBeNull();
      expect(parseScriptedActionId('social:abc:seduce')).toBeNull();
    });

    it('rejects empty check kind', () => {
      expect(parseScriptedActionId('social:200:')).toBeNull();
    });

    it('rejects missing or extra segments', () => {
      expect(parseScriptedActionId('social:200')).toBeNull();
      expect(parseScriptedActionId('social:200:seduce:bonus')).toBeNull();
    });
  });

  describe('item-check', () => {
    it('parses item-check:<itemId>:<checkKind>', () => {
      expect(parseScriptedActionId('item-check:302:str_shove')).toEqual({
        kind: 'item-check',
        itemId: 302,
        checkKind: 'str_shove',
      });
    });

    it('rejects zero / negative / non-integer item ids', () => {
      expect(parseScriptedActionId('item-check:0:lift')).toBeNull();
      expect(parseScriptedActionId('item-check:-7:lift')).toBeNull();
      expect(parseScriptedActionId('item-check:1.5:lift')).toBeNull();
      expect(parseScriptedActionId('item-check:xyz:lift')).toBeNull();
    });

    it('rejects empty check kind', () => {
      expect(parseScriptedActionId('item-check:302:')).toBeNull();
    });

    it('rejects missing or extra segments', () => {
      expect(parseScriptedActionId('item-check:302')).toBeNull();
      expect(parseScriptedActionId('item-check:302:str_shove:extra')).toBeNull();
    });
  });

  describe('attack', () => {
    it('parses attack:<npcId>', () => {
      expect(parseScriptedActionId('attack:201')).toEqual({
        kind: 'attack',
        npcId: 201,
      });
    });

    it('rejects zero / negative / non-integer npc ids', () => {
      expect(parseScriptedActionId('attack:0')).toBeNull();
      expect(parseScriptedActionId('attack:-5')).toBeNull();
      expect(parseScriptedActionId('attack:NaN')).toBeNull();
      expect(parseScriptedActionId('attack:abc')).toBeNull();
    });

    it('rejects missing or extra segments', () => {
      expect(parseScriptedActionId('attack:')).toBeNull();
      expect(parseScriptedActionId('attack:201:critical')).toBeNull();
    });
  });

  describe('scene choice', () => {
    it('parses scene.choose:<sceneSlug>:<choiceNumber>', () => {
      expect(
        parseScriptedActionId('scene.choose:arrival-with-a-revolver:2'),
      ).toEqual({
        kind: 'scene-choice',
        sceneSlug: 'arrival-with-a-revolver',
        choiceNumber: 2,
      });
    });

    it('rejects malformed scene choices', () => {
      expect(parseScriptedActionId('scene.choose::2')).toBeNull();
      expect(parseScriptedActionId('scene.choose:arrival:0')).toBeNull();
      expect(parseScriptedActionId('scene.choose:arrival:-1')).toBeNull();
      expect(parseScriptedActionId('scene.choose:arrival:1.5')).toBeNull();
      expect(parseScriptedActionId('scene.choose:arrival:abc')).toBeNull();
      expect(parseScriptedActionId('scene.choose:arrival')).toBeNull();
      expect(parseScriptedActionId('scene.choose:arrival:1:extra')).toBeNull();
    });
  });

  describe('non-scripted ids', () => {
    it('returns null for undefined, null, and empty strings', () => {
      expect(parseScriptedActionId(undefined)).toBeNull();
      expect(parseScriptedActionId(null)).toBeNull();
      expect(parseScriptedActionId('')).toBeNull();
    });

    it('returns null for unrelated prefixes', () => {
      expect(parseScriptedActionId('travel:404')).toBeNull();
      expect(parseScriptedActionId('quest:1:start')).toBeNull();
      expect(parseScriptedActionId('continue')).toBeNull();
    });

    it('returns null for free-text turns', () => {
      expect(parseScriptedActionId('I look around the room')).toBeNull();
      expect(parseScriptedActionId(':200:seduce')).toBeNull();
    });
  });
});
