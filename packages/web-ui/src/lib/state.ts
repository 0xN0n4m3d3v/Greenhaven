// Pure state utilities. Extracted verbatim from App.tsx (spec 29
// decomposition). No React, no DOM mutation — just transformations
// over GameState + PatchReport, plus a couple of small helpers used
// across components.

import {engine} from '../bridge/platform';
import type {GameState, PatchReport} from '../types/app';
import {CLIENT_STORAGE_KEYS, readClientStorage} from './clientStorage';
import {recordFrontendEvent} from './frontendTelemetry';
import {normalizeSupportedLanguageCode} from './languages';

// In the Greenhaven web build, the bridge always wires up to a Hono
// server over HTTP+SSE. The original Wails check is obsolete — we
// always have a backend. Returning true suppresses the
// `browserFallbackState` "Backend required" UI that was meant for the
// no-Wails-runtime case.
export function hasWailsBackend() {
  return true;
}

export function logFrontend(level: string, event: string, message: string, data: unknown = {}) {
  // U-2 / UI-7 / UI-8 — `recordFrontendEvent` posts to the canonical
  // `/api/telemetry` endpoint, which is the single sink for both web
  // and desktop targets. The previous host-runtime probe is gone — a
  // desktop target would now wire `LogFrontendEvent` through
  // `bridge/platform` instead of touching any browser-side global.
  recordFrontendEvent(
    normalizeLogLevel(level),
    event,
    message,
    data && typeof data === 'object' ? data as Record<string, unknown> : {data},
  );
}

function normalizeLogLevel(level: string): 'debug' | 'info' | 'warn' | 'error' | 'fatal' {
  if (level === 'debug' || level === 'info' || level === 'warn' || level === 'error' || level === 'fatal') {
    return level;
  }
  return 'info';
}

export function delay(ms: number) {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error(`${label} did not answer within ${timeoutMs}ms`)),
      timeoutMs,
    );
    promise.then(
      value => {
        window.clearTimeout(timer);
        resolve(value);
      },
      err => {
        window.clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export function safeArray<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

export function normalizeState(nextState: GameState | null | undefined): GameState {
  if (!nextState) {
    throw new Error('Runtime returned empty game state');
  }
  return {
    ...nextState,
    currentLocation:
      nextState.currentLocation ?? {id: 0, name: 'Unknown', status: 'unknown', unread: 0},
    currentScene:
      nextState.currentScene ??
      ({id: 0, type: 'scene', name: 'Unknown', summary: '', status: [], state: [], tags: []} as engine.EntityCard),
    focusEntity:
      nextState.focusEntity ??
      ({id: 0, type: 'person', name: 'Unknown', summary: '', status: [], state: [], tags: []} as engine.EntityCard),
    locations: safeArray(nextState.locations),
    nearby: safeArray(nextState.nearby),
    hero: {
      id: nextState.hero?.id ?? 0,
      name: nextState.hero?.name ?? 'Character',
      statuses: safeArray(nextState.hero?.statuses),
      states: safeArray(nextState.hero?.states),
    } as engine.HeroSummary,
    inventory: safeArray(nextState.inventory),
    worldEntities: safeArray(nextState.worldEntities),
    quests: safeArray(nextState.quests),
    memories: safeArray(nextState.memories),
    messages: safeArray(nextState.messages),
    actions: safeArray(nextState.actions),
    runtimeSlots: safeArray(nextState.runtimeSlots),
    provider:
      nextState.provider ??
      ({mode: 'unknown', model: 'unknown', online: false} as engine.ProviderStatus),
  } as unknown as GameState;
}

export function normalizePatchReport(
  report: PatchReport | null | undefined,
): PatchReport | null {
  if (!report) return null;
  return {
    ...report,
    inventory: safeArray(report.inventory),
    fields: safeArray(report.fields),
    transitions: safeArray(report.transitions),
    memory: safeArray(report.memory),
  } as PatchReport;
}

export function patchReportLines(report: PatchReport | null): string[] {
  if (!report) return [];
  return [
    ...safeArray(report.inventory),
    ...safeArray(report.fields),
    ...safeArray(report.transitions),
    ...safeArray(report.memory),
  ];
}

export function mentionTypeClass(type: string | undefined) {
  const normalized = (type || 'entity').toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return `inline-mention mention-${normalized || 'entity'}`;
}

export function detectClientLanguage(): string {
  // Same priority as bridge/api.ts GetUiLanguage: persisted setting
  // wins, then browser hint, then 'en'.
  const saved = normalizeSupportedLanguageCode(
    readClientStorage(CLIENT_STORAGE_KEYS.uiLanguage),
  );
  if (saved) return saved;
  if (typeof navigator !== 'undefined' && navigator.language) {
    return normalizeSupportedLanguageCode(navigator.language) ?? 'en';
  }
  return 'en';
}
