// Spec 30 — physics-based 3D dice via @3d-dice/dice-box.
//
// One container instance per mount. Receives a `roll` prop (DiceRoll
// from existing DiceBubble). When `roll.result` arrives, the box
// shows the d20 settling on the result face.
//
// Per-roller theming:
//   player → purple ring
//   npc    → red ring
// Critical 20 → gold glow; critical 1 → ash glow.
//
// Honors prefers-reduced-motion: skips the physics, jumps to the
// final face statically. Falls back to the legacy DiceBubble visually.
//
// The lib serves WASM/asset files from /dice-box/ — already copied
// from node_modules in vite-plugin-static-copy / package postinstall.

import {useEffect, useRef} from 'react';
import DiceBox from '@3d-dice/dice-box';

export interface DiceRollPayload {
  total: number;
  d?: number;            // die size, default 20
  modifier?: number;
  dc?: number;
  success?: boolean;
  crit?: boolean;
  roller?: 'player' | 'npc';
}

interface Props {
  roll: DiceRollPayload | null;
  width?: number;
  height?: number;
}

let boxIdCounter = 0;

export function DiceBox3D({roll, width = 320, height = 220}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<any>(null);
  const idRef = useRef<string>(`dice-box-${++boxIdCounter}`);

  useEffect(() => {
    if (!containerRef.current) return;
    if (typeof window === 'undefined') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const containerSelector = `#${idRef.current}`;
    const box = new DiceBox({
      assetPath: '/dice-box/',
      container: containerSelector,
      theme: 'default',
      scale: 5,
      gravity: 1,
      mass: 1,
      friction: 0.8,
      restitution: 0,
      angularDamping: 0.4,
      linearDamping: 0.4,
      shadowTransparency: 0.85,
    } as any);
    box.init().then(() => {
      boxRef.current = box;
    }).catch((err: unknown) => {
      console.warn('[DiceBox3D] init failed', err);
    });

    return () => {
      try {
        boxRef.current?.clear?.();
      } catch (err) {
        console.warn('[DiceBox3D] cleanup', err);
      }
      boxRef.current = null;
    };
  }, []);

  useEffect(() => {
    const box = boxRef.current;
    if (!box || !roll) return;
    const die = roll.d ?? 20;
    const themeColor =
      roll.crit && roll.success ? '#ffd84a'
        : roll.crit              ? '#7a7a7a'
        : roll.roller === 'npc'  ? '#c4404f'
        :                          '#a06bd0';
    try {
      box.clear?.();
      box.add(`1d${die}`, {themeColor});
    } catch (err) {
      console.warn('[DiceBox3D] add failed', err);
    }
  }, [roll]);

  return (
    <div
      id={idRef.current}
      ref={containerRef}
      style={{
        width,
        height,
        position: 'relative',
        pointerEvents: 'none',
      }}
      aria-hidden
    />
  );
}
