// browserFallbackState — placeholder GameState used when the Hono backend
// is not reachable. The normal web and Electron builds have a Greenhaven
// backend, so this is dead in practice, but App.tsx still references it on
// a few code paths for safety. Extracted from App.tsx (spec 29).

import type {GameState} from '../types/app';

export const browserFallbackState = {
  dbPath: 'browser demo mode: start the Greenhaven backend',
  currentLocation: {id: 90, name: 'Quickgrin Lane', status: 'browser preview', unread: 0},
  locations: [
    {id: 90, name: 'Quickgrin Lane', status: 'browser preview', unread: 0},
    {id: 100, name: 'Velvet Booths', status: 'backend locked', unread: 1},
  ],
  nearby: [{id: 1, name: 'Mikka Quickgrin', status: 'preview'}],
  hero: {id: 0, name: 'Character', statuses: ['preview'], states: ['backend required']},
  messages: [
    {
      id: 1,
      authorId: 90,
      author: 'Quickgrin Lane',
      tone: 'system',
      text: 'This is browser preview mode. Start the Greenhaven backend to use runtime patches, transitions, and memory.',
      turn: 1,
    },
  ],
  actions: [
    {
      id: 'preview',
      label: 'Backend required',
      message: 'Start the Greenhaven backend to use the runtime.',
      primary: true,
    },
  ],
  runtimeSlots: [],
} as unknown as GameState;
