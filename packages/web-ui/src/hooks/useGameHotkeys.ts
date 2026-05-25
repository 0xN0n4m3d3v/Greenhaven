/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-SHELL-1 — RPG-style global hotkeys.
//
//   J — Notice Journal surface
//   Q — Quest Dashboard surface
//   I — Inventory surface
//   P — Character State surface (previously: the legacy profile modal)
//       tab — that legacy mapping is gone)
//   B — Bonds / Relationships surface (FEAT-REL-1)
//   M — Map (CityMapModal)
//   Esc — close everything that is open
//
// Uses `event.code` so Cyrillic / non-QWERTY keyboards still trigger
// the same physical key. Skips when focus is on a textarea / input /
// contenteditable so typing in the composer never hits a hotkey.

import {useEffect} from 'react';

export type SurfaceKind =
  | 'inventory'
  | 'quests'
  | 'journal'
  | 'character'
  | 'bonds';

export interface GameHotkeysHandlers {
  openMap: () => void;
  openSurface: (kind: SurfaceKind) => void;
  closeAll: () => void;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (target.isContentEditable) return true;
  return false;
}

export function useGameHotkeys(handlers: GameHotkeysHandlers): void {
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'Escape') {
        handlers.closeAll();
        return;
      }
      // Skip if typing somewhere.
      if (isTypingTarget(event.target)) return;
      switch (event.code) {
        case 'KeyJ':
          event.preventDefault();
          handlers.openSurface('journal');
          return;
        case 'KeyQ':
          event.preventDefault();
          handlers.openSurface('quests');
          return;
        case 'KeyI':
          event.preventDefault();
          handlers.openSurface('inventory');
          return;
        case 'KeyM':
          event.preventDefault();
          handlers.openMap();
          return;
        case 'KeyP':
          event.preventDefault();
          handlers.openSurface('character');
          return;
        case 'KeyB':
          event.preventDefault();
          handlers.openSurface('bonds');
          return;
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [handlers]);
}
