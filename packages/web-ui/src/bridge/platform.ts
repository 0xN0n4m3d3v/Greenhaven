// U-2 / UI-7 / UI-8 — platform facade.
//
// This module is the SINGLE allowed touchpoint for desktop-shaped
// runtime/model/app concerns. Every other file in
// `packages/web-ui/src/**` must import models, App methods, the
// runtime event bus, and the factory helpers from
// `bridge/platform.ts` so the rest of the UI tree stays free of
// platform-specific imports.
//
// The web build resolves these to the local copy of the model
// namespaces in `bridge/models.ts`, the Hono HTTP/SSE shims in
// `bridge/api.ts`, and the in-process pub/sub in `bridge/runtime.ts`.
// A future desktop target can swap any of these implementations
// behind this same facade without touching any consumer file —
// `IS_DESKTOP_TARGET` (driven by `vite.config.ts` → `VITE_TARGET`)
// is the discriminator consumers should branch on.

// ─── Platform target flag ───────────────────────────────────────
// `VITE_TARGET` is replaced at build time via `vite.config.ts`'s
// `define` block (default `'web'`). Consumers that need to choose
// between the async-job desktop path and the simpler web sync path
// should read `IS_DESKTOP_TARGET` here rather than probing for any
// host-runtime globals.
export const IS_DESKTOP_TARGET: boolean =
  import.meta.env.VITE_TARGET === 'desktop';

// ─── Model namespaces ───────────────────────────────────────────
// `bridge/models.ts` is a local copy of the Wails-emitted shapes
// (plain class fields + a `createFrom` static). Runtime values are
// routed through the typed factory helpers below so consumers don't
// need to touch `createFrom` directly.
export {engine, i18n, main} from './models';
import {engine, i18n, main} from './models';

// ─── Runtime event bus ──────────────────────────────────────────
// `EventsOn` / `EventsEmit` belong to the runtime shim. Everything
// downstream imports from this facade so the desktop target can
// re-bind them to the real desktop event bus.
export {EventsOn, EventsEmit, __emit} from './runtime';

// ─── App method surface ─────────────────────────────────────────
// The web build's HTTP/SSE App methods live in `bridge/api.ts`.
// They are re-exported here so consumers import a stable surface
// regardless of platform target.
export {
  AcceptPlayerAdventure,
  CancelTurnJob,
  ClearLocalClientStorage,
  ContinueLastTurn,
  ContinueLastTurnAsync,
  EndDialogue,
  GetAvailableLanguages,
  GetCurrentPlayerId,
  GetGameState,
  GetModelOverride,
  GetPendingTurnJobs,
  GetPlayerAdventures,
  GetPlayerProfile,
  GetTranslations,
  GetTurnJob,
  GetUiLanguage,
  IgnorePlayerAdventure,
  ListLocalClientStorage,
  LogFrontendEvent,
  ResetGame,
  SetModel,
  SetUiLanguage,
  SignOut,
  StartDialogue,
  SubmitPlayerAction,
  SubmitPlayerActionAsync,
  SubmitPlayerMessage,
  SubmitPlayerMessageAsync,
  WaitForTurnJob,
  getBrokerModel,
  getNarratorModel,
  setRoleModels,
  type PlayerAdventure,
  type PlayerProfile,
} from './api';

// ─── Model factory helpers ──────────────────────────────────────
// These wrap the generated `createFrom` factories so caller files
// (most notably `sseClient.ts` and other bridge modules) do not
// need to import the generated namespaces. The runtime shape is
// preserved verbatim — `createFrom` only copies fields onto the
// produced instance.

export function createGameState(source: unknown): engine.GameState {
  return engine.GameState.createFrom(source as Record<string, unknown>);
}

export function createTurnResult(source: unknown): engine.TurnResult {
  return engine.TurnResult.createFrom(source as Record<string, unknown>);
}

export function createChatMessage(source: unknown): engine.ChatMessage {
  return engine.ChatMessage.createFrom(source as Record<string, unknown>);
}

export function createPatchReport(source: unknown): engine.PatchReport {
  return engine.PatchReport.createFrom(source as Record<string, unknown>);
}

export function createLocationSummary(source: unknown): engine.LocationSummary {
  return engine.LocationSummary.createFrom(source as Record<string, unknown>);
}

export function createHeroSummary(source: unknown): engine.HeroSummary {
  return engine.HeroSummary.createFrom(source as Record<string, unknown>);
}

export function createEntityCard(source: unknown): engine.EntityCard {
  return engine.EntityCard.createFrom(source as Record<string, unknown>);
}

export function createLanguage(source: unknown): i18n.Language {
  return i18n.Language.createFrom(source as Record<string, unknown>);
}

export function createTurnJobSnapshot(source: unknown): main.TurnJobSnapshot {
  return main.TurnJobSnapshot.createFrom(source as Record<string, unknown>);
}
