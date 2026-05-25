// App-wide type aliases. Extracted from App.tsx during spec 29
// decomposition. Keeps the entry-point file small and lets new
// components import these types without pulling App.tsx itself.

import {engine, main} from '../bridge/platform';

export type GameState = engine.GameState;
export type Action = engine.Action;
export type PatchReport = engine.PatchReport;

// TurnJobSnapshot mirrors the Go struct (drift-protected via main.TurnJobSnapshot)
// but narrows `status` to the runtime's terminal-state union and allows null
// for `result` since the Go side serializes a nil pointer as JSON null.
export type TurnJobSnapshot = Omit<main.TurnJobSnapshot, 'status' | 'result' | 'convertValues'> & {
  status: 'queued' | 'running' | 'done' | 'error' | 'canceled';
  result?: engine.TurnResult | null;
};

export type MentionTarget = {
  id: number;
  name: string;
  type?: string;
  actionId?: string;
  actionMessage?: string;
};

export type MentionMatch = {
  trigger: string;
  target: MentionTarget;
};
