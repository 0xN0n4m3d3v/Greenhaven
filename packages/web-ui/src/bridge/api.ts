// api.ts — drop-in replacement for the desktop App binding surface.
// Function signatures match the Wails-generated bindings so App.tsx
// builds unchanged. The actual implementation talks to the Hono web-server
// at /api over HTTP, plus an SSE channel for streaming events.
//
// Design constraints:
//   - The web-ui's existing event taxonomy ('turn:token' /
//     'turn:stream_done') stays — we translate web-server SSE events
//     into those names so App.tsx didn't need editing.
//   - The web-ui treats turns as JOBS: SubmitPlayerMessageAsync returns
//     a TurnJobSnapshot, then App.tsx polls GetTurnJob(jobId). Our HTTP
//     backend has no polling — it has SSE. We keep a local Map of jobs
//     and update it from SSE events; GetTurnJob just reads the Map.
//   - GameState shape is rich (locations, hero, runtime fields, …) but
//     Greenhaven has no cartridge yet. We synthesise a minimal stub so
//     the UI renders without the empty-state crashes.

import { engine, i18n, main } from './platform';
import {
  normalizeSupportedLanguageCode,
  SUPPORTED_LANGUAGES,
} from '../lib/languages';
import {
  CLIENT_STORAGE_KEYS,
  readClientStorage,
  writeClientStorage,
  type GreenhavenStorageEntry,
} from '../lib/clientStorage';
import { recordFrontendEvent } from '../lib/frontendTelemetry';
import { createSessionResetBridge } from './sessionReset';
import { createBridgeBootstrap, type BridgeRuntime } from './bootstrap';
import { dispatchAdventureChanged, replayGuiEvents } from './eventTimeline';
import {
  applyClientCacheReset,
  createPlaythroughBridge,
  type ClearClientCacheHint,
  type PlaythroughLaunchResult,
  type PlaythroughPreview,
} from './playthrough';
import { emptyPatchReport } from './stateReconciler';
import { createSseStreamClient } from './sseClient';
import { createTurnJobBridge } from './turnJobs';

const API_BASE = '/api';

// --------------------------------------------------------------- bootstrap

const UI_LANGUAGE_KEY = CLIENT_STORAGE_KEYS.uiLanguage;

const sseClient = createSseStreamClient({
  getBridge: () => getBridge(),
  resetBootstrap: () => resetBootstrap(),
  refreshPersistedMessages: (runtime, reason) =>
    refreshPersistedMessages(runtime, reason),
  refreshPlayer: (runtime) => refreshPlayer(runtime),
  refreshAffordances: (runtime) => refreshAffordances(runtime),
});

// --------------------------------------------------------------- helpers

async function postJSON<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(API_BASE + path, {
    method: 'POST',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'include',
  });
  if (!res.ok) {
    let payload: { error?: string; message?: string } | null = null;
    try {
      payload = (await res.json()) as { error?: string; message?: string };
    } catch {
      // ignore non-JSON errors
    }
    const code = payload?.error ?? payload?.message;
    throw new Error(
      code
        ? `${path} -> ${res.status} ${code}`
        : `${path} -> ${res.status} ${res.statusText}`,
    );
  }
  return (await res.json()) as T;
}

async function deleteJSON<T>(path: string): Promise<T> {
  const res = await fetch(API_BASE + path, {
    method: 'DELETE',
    credentials: 'include',
  });
  if (!res.ok) {
    let payload: { error?: string; message?: string } | null = null;
    try {
      payload = (await res.json()) as { error?: string; message?: string };
    } catch {
      // ignore non-JSON errors
    }
    const code = payload?.error ?? payload?.message;
    throw new Error(
      code
        ? `${path} -> ${res.status} ${code}`
        : `${path} -> ${res.status} ${res.statusText}`,
    );
  }
  return (await res.json()) as T;
}

async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(API_BASE + path, { credentials: 'include' });
  if (!res.ok) {
    let payload: { error?: string; message?: string } | null = null;
    try {
      payload = (await res.json()) as { error?: string; message?: string };
    } catch {
      // ignore non-JSON errors
    }
    const code = payload?.error ?? payload?.message;
    throw new Error(
      code
        ? `${path} -> ${res.status} ${code}`
        : `${path} -> ${res.status} ${res.statusText}`,
    );
  }
  return (await res.json()) as T;
}

const bridgeBootstrap = createBridgeBootstrap({
  openSseStream: sseClient.openSseStream,
  replayGuiEvents,
});

function getBridge(): Promise<BridgeRuntime> {
  return bridgeBootstrap.getBridge();
}

function resetBootstrap(): void {
  bridgeBootstrap.resetBootstrap();
}

const refreshPersistedMessages = bridgeBootstrap.refreshPersistedMessages;
const refreshPlayer = bridgeBootstrap.refreshPlayer;
const refreshAffordances = bridgeBootstrap.refreshAffordances;

const turnJobs = createTurnJobBridge({
  getBridge,
  getJSON,
  postJSON,
  refreshPersistedMessages,
  refreshPlayer,
  emptyPatchReport,
  readUiLanguage: () => readClientStorage(UI_LANGUAGE_KEY),
  resetBootstrap,
  recordFrontendEvent,
});

const sessionReset = createSessionResetBridge({
  getBridge,
  postJSON,
  resetBootstrap,
});

// --------------------------------------------------------------- public API

/**
 * Forget the current player on this device. The server-side row is
 * untouched — the player can come back via POST /api/player/restore
 * with their recovery code. Caller is expected to follow this with a
 * full reload so ensurePlayer() runs again from a clean slate.
 */
/**
 * Focus the player onto an NPC. Subsequent turns route through this
 * NPC's per-player thread on the server. The active dialogue partner
 * is server-side state (`players.dialogue_partner_id`); this call
 * just sets it. UI surfaces "in dialogue with X" through the player
 * snapshot on the next /me read or via local state.
 */
export async function StartDialogue(npcId: number): Promise<{
  npcId: number;
  npcName: string;
}> {
  const b = await getBridge();
  const r = await postJSON<{ npcId: number; npcName: string }>(
    `/session/${encodeURIComponent(b.sessionId)}/dialogue/start`,
    { playerId: b.player.entity_id, npcId },
  );
  return r;
}

export async function EndDialogue(): Promise<void> {
  const b = await getBridge();
  await postJSON(`/session/${encodeURIComponent(b.sessionId)}/dialogue/end`, {
    playerId: b.player.entity_id,
  });
}

/** Hot-swap the LLM for the current session. Persisted server-side
 *  for the duration of the session AND in localStorage so future
 *  sessions on this device default to the same choice. */
export async function SetModel(model: string): Promise<void> {
  const b = await getBridge();
  await postJSON(`/session/${encodeURIComponent(b.sessionId)}/model`, {
    model,
    playerId: b.player.entity_id,
  });
  writeClientStorage(CLIENT_STORAGE_KEYS.modelOverride, model);
}

export function GetModelOverride(): string | null {
  return readClientStorage(CLIENT_STORAGE_KEYS.modelOverride);
}

// --- DeepSeek V2 broker / narrator role models -------------------------
// Distinct from SetModel above (which targets the v1 single-model path).
// These hit POST /api/session/:id/models which mutates Session.providers
// for the v2 turn-runner introduced in spec 04.

const BROKER_KEY = CLIENT_STORAGE_KEYS.brokerModel;
const NARRATOR_KEY = CLIENT_STORAGE_KEYS.narratorModel;

export function getBrokerModel(): string {
  return readClientStorage(BROKER_KEY) ?? 'deepseek-v4-flash';
}

export function getNarratorModel(): string {
  return readClientStorage(NARRATOR_KEY) ?? 'deepseek-v4-pro';
}

export async function setRoleModels(opts: {
  broker?: string;
  narrator?: string;
}): Promise<void> {
  const b = await getBridge();
  const body: Record<string, unknown> = { playerId: b.player.entity_id };
  if (opts.broker) body['broker'] = { modelId: opts.broker };
  if (opts.narrator) body['narrator'] = { modelId: opts.narrator };
  const res = await fetch(
    `${API_BASE}/session/${encodeURIComponent(b.sessionId)}/models`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'include',
    },
  );
  if (!res.ok) throw new Error(`setRoleModels failed: ${res.status}`);
  if (opts.broker) writeClientStorage(BROKER_KEY, opts.broker);
  if (opts.narrator) writeClientStorage(NARRATOR_KEY, opts.narrator);
}

export function SignOut(): void {
  sessionReset.SignOut();
}

export function ListLocalClientStorage(): GreenhavenStorageEntry[] {
  return sessionReset.ListLocalClientStorage();
}

export function ClearLocalClientStorage(
  opts: { keepPreferences?: boolean } = {},
): string[] {
  return sessionReset.ClearLocalClientStorage(opts);
}

export async function GetGameState(): Promise<engine.GameState> {
  const b = await getBridge();
  await refreshPlayer(b);
  return engine.GameState.createFrom(b.state);
}

export async function GetPendingTurnJobs(): Promise<main.TurnJobSnapshot[]> {
  return turnJobs.GetPendingTurnJobs();
}

export async function ResetGame(): Promise<engine.GameState> {
  return sessionReset.ResetGame();
}

// Sync variants of "submit" — used by App.tsx in some code paths.
// We satisfy the contract by waiting on the matching async job's done state.
export async function SubmitPlayerMessage(
  text: string,
): Promise<engine.TurnResult> {
  return turnJobs.SubmitPlayerMessage(text);
}

export async function SubmitPlayerAction(
  actionId: string,
  text: string,
): Promise<engine.TurnResult> {
  return turnJobs.SubmitPlayerAction(actionId, text);
}

export async function ContinueLastTurn(): Promise<engine.TurnResult> {
  return turnJobs.ContinueLastTurn();
}

// -- async (job-style) ---------------------------------------------------------

export function SubmitPlayerMessageAsync(
  text: string,
): Promise<main.TurnJobSnapshot> {
  return turnJobs.SubmitPlayerMessageAsync(text);
}

export function SubmitPlayerActionAsync(
  actionId: string,
  text: string,
): Promise<main.TurnJobSnapshot> {
  return turnJobs.SubmitPlayerActionAsync(actionId, text);
}

export async function ContinueLastTurnAsync(): Promise<main.TurnJobSnapshot> {
  // See ContinueLastTurn — return a synthetic 'done' job.
  return turnJobs.ContinueLastTurnAsync();
}

export async function GetTurnJob(jobId: string): Promise<main.TurnJobSnapshot> {
  return turnJobs.GetTurnJob(jobId);
}

export async function CancelTurnJob(
  jobId: string,
): Promise<main.TurnJobSnapshot> {
  return turnJobs.CancelTurnJob(jobId);
}

/**
 * Resolve once the job reaches a terminal state. If it's already
 * terminal in the local Map, resolve synchronously on next tick.
 * Otherwise registers the resolver in {@link jobWaiters} — the SSE
 * handlers wake it via {@link settleJob} the instant the server says
 * so. No polling, no ceiling.
 */
export function WaitForTurnJob(jobId: string): Promise<main.TurnJobSnapshot> {
  return turnJobs.WaitForTurnJob(jobId);
}

// Sync wrappers — wait on the same event-driven mechanism. The SSE
// channel is the only source of truth for job termination; if it
// never fires, both this and the async path hang forever, which is
// the right contract (caller can cancel via CancelTurnJob).
// -- i18n ----------------------------------------------------------------------
// Backend has no i18n endpoints — translations live entirely on the
// frontend for now. When the cartridge introduces multi-locale text,
// these dictionaries get populated from cartridge data instead.

export async function GetAvailableLanguages(): Promise<i18n.Language[]> {
  return SUPPORTED_LANGUAGES.map((language) =>
    i18n.Language.createFrom(language),
  );
}

export async function GetTranslations(
  locale: string,
): Promise<Record<string, string>> {
  const { getUiTranslations } = await import('../lib/uiMessages');
  return getUiTranslations(locale);
}

export async function GetUiLanguage(): Promise<string> {
  // Persisted choice from settings wins; otherwise fall back to the
  // browser's first-launch hint, then English.
  const saved = normalizeSupportedLanguageCode(
    readClientStorage(UI_LANGUAGE_KEY),
  );
  if (saved) return saved;
  const lang = (typeof navigator !== 'undefined' ? navigator.language : 'en')
    .toLowerCase()
    .slice(0, 2);
  return normalizeSupportedLanguageCode(lang) ?? 'en';
}

export async function SetUiLanguage(
  locale: string,
): Promise<Record<string, string>> {
  // Persist so the same choice survives reloads AND so
  // startTurnOnServer can read it to ship to the model.
  const normalized = normalizeSupportedLanguageCode(locale);
  if (normalized) writeClientStorage(UI_LANGUAGE_KEY, normalized);
  return GetTranslations(normalized ?? 'en');
}

export async function LogFrontendEvent(
  level: string,
  event: string,
  msg: string,
  data: string,
): Promise<void> {
  // Future: POST /api/log. For now, mirror to console so dev sees it.
  console.debug(`[ui:${level}] ${event}`, msg, data);
}

// ─── Profile API (spec 26 wizard gate) ──────────────────────────────────

export interface PlayerProfile {
  created?: boolean;
  identity?: Record<string, unknown>;
  physical?: Record<string, unknown>;
  background?: Record<string, unknown>;
  starting_class_id?: number | null;
  [k: string]: unknown;
}

/** Lightweight accessor — wait for bootstrap, return the player.entity_id. */
export async function GetCurrentPlayerId(): Promise<number> {
  const b = await getBridge();
  return b.player.entity_id;
}

export interface PlayerAdventure {
  queueId: number;
  sessionId: string;
  playerId: number;
  turnId: string | null;
  status: string;
  adventureKind: string;
  title: string;
  summary: string;
  playerFacingHook: string;
  danger: unknown;
  speakerEntityId: number | null;
  speakerName: string | null;
  source: string;
  createdAt: string;
  updatedAt: string;
  acceptUrl: string;
  ignoreUrl: string;
}

export async function GetPlayerAdventures(
  playerId?: number,
): Promise<PlayerAdventure[]> {
  const b = await getBridge();
  const resolvedPlayerId = b.player.entity_id;
  if (playerId != null && playerId !== resolvedPlayerId) {
    console.warn(
      `[adventure] ignored stale UI playerId ${playerId}; bridge player is ${resolvedPlayerId}`,
    );
  }
  const body = await getJSON<{ adventures?: PlayerAdventure[] }>(
    `/player/${encodeURIComponent(String(resolvedPlayerId))}/adventures?sessionId=${encodeURIComponent(b.sessionId)}`,
  );
  return Array.isArray(body.adventures) ? body.adventures : [];
}

export async function AcceptPlayerAdventure(
  playerId: number,
  queueId: number,
): Promise<{ ok: boolean; status?: string }> {
  const b = await getBridge();
  const resolvedPlayerId = b.player.entity_id;
  if (playerId !== resolvedPlayerId) {
    console.warn(
      `[adventure] ignored stale accept playerId ${playerId}; bridge player is ${resolvedPlayerId}`,
    );
  }
  const result = await postJSON<{ ok: boolean; status?: string }>(
    `/player/${encodeURIComponent(String(resolvedPlayerId))}/adventures/${encodeURIComponent(String(queueId))}/accept`,
    { sessionId: b.sessionId },
  );
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('quest:changed', { detail: result }));
  }
  dispatchAdventureChanged({
    source: 'accept',
    playerId: resolvedPlayerId,
    queueId,
    result,
  });
  return result;
}

export async function IgnorePlayerAdventure(
  playerId: number,
  queueId: number,
): Promise<{ ok: boolean; status?: string }> {
  const b = await getBridge();
  const resolvedPlayerId = b.player.entity_id;
  if (playerId !== resolvedPlayerId) {
    console.warn(
      `[adventure] ignored stale ignore playerId ${playerId}; bridge player is ${resolvedPlayerId}`,
    );
  }
  const result = await postJSON<{ ok: boolean; status?: string }>(
    `/player/${encodeURIComponent(String(resolvedPlayerId))}/adventures/${encodeURIComponent(String(queueId))}/ignore`,
    { sessionId: b.sessionId, reason: 'player_ignored' },
  );
  dispatchAdventureChanged({
    source: 'ignore',
    playerId: resolvedPlayerId,
    queueId,
    result,
  });
  return result;
}

/** Fetch the player's full profile (entities[kind='player'].profile JSONB). */
export async function GetPlayerProfile(playerId: number): Promise<{
  display_name: string;
  profile: PlayerProfile;
}> {
  const r = await fetch(
    `${API_BASE}/player/${encodeURIComponent(String(playerId))}/profile`,
    {
      credentials: 'include',
    },
  );
  if (!r.ok)
    throw new Error(`GET /player/${playerId}/profile failed: ${r.status}`);
  return r.json() as Promise<{ display_name: string; profile: PlayerProfile }>;
}

// ─── FEAT-CART-LIB-5 — cartridge library bridge ───────────────────────

export interface CartridgeInstallCacheView {
  ready: boolean;
  state: string;
  contentHash: string;
  recordCount: number;
  lastVerifiedAt: string;
  importRequired: boolean;
}

export interface CartridgeSummaryView {
  id: string;
  title: string;
  version: string;
  status: 'installed' | 'invalid' | 'needs_review' | 'deprecated';
  contentHash: string;
  counts: {locations: number; people: number; quests: number; scenes: number; items: number};
  installedAt: string;
  updatedAt: string;
  lastImportAt: string | null;
  validation: {errors: number; warnings: number};
  startingLocationName: string | null;
  source: {kind: string; path: string | null; generatedFrom: string | null};
  isDefault: boolean;
  installCache: CartridgeInstallCacheView | null;
}

export interface HeroSummaryView {
  playerId: number;
  publicId: string;
  name: string;
  level: number;
  xp: number;
  profileCreated: boolean;
  lastSeenAt: string | null;
  currentCartridgeId: string | null;
  states: Array<{
    cartridgeId: string;
    status: 'available' | 'active' | 'incompatible' | 'archived';
    lastLocationName: string | null;
    lastSessionId: string | null;
    updatedAt: string;
  }>;
}

export async function ListCartridges(): Promise<CartridgeSummaryView[]> {
  const r = await getJSON<{cartridges: CartridgeSummaryView[]}>('/cartridges');
  return Array.isArray(r.cartridges) ? r.cartridges : [];
}

// FEAT-ENGINE-BASELINE-6 — first-run / boot-time library status.
//
// BootGate calls this BEFORE the player bootstrap so it can route
// directly into Worlds & Heroes when nothing is installed yet, and
// so MainMenu can decide whether to surface Continue / New Game
// without ever calling `/api/player/anonymous`.

export interface LibraryStatusView {
  cartridgeCount: number;
  readyCartridgeCount: number;
  heroCount: number;
  activePlaythroughCount: number;
  defaultForgeProject: {
    path: string;
    available: boolean;
  };
  bootMedia?: {
    cartridgeId: string;
    bundles: Array<{
      id: string;
      posterUrl: string | null;
      videoUrl: string | null;
      musicUrl: string | null;
    }>;
  } | null;
}

export async function GetLibraryStatus(): Promise<LibraryStatusView> {
  return await getJSON<LibraryStatusView>('/cartridges/library/status');
}

export interface FilesystemDirectoryEntryView {
  name: string;
  path: string;
  obsidianVault: boolean;
  forgeProject: boolean;
  agentManual: boolean;
}

export interface FilesystemDirectoryBrowserView {
  currentPath: string;
  parentPath: string | null;
  truncated: boolean;
  obsidianVault: boolean;
  forgeProject: boolean;
  agentManual: boolean;
  entries: FilesystemDirectoryEntryView[];
}

export async function BrowseFilesystemDirectories(
  sourcePath?: string | null,
): Promise<FilesystemDirectoryBrowserView> {
  const qs =
    sourcePath && sourcePath.trim().length > 0
      ? `?path=${encodeURIComponent(sourcePath.trim())}`
      : '';
  return await getJSON<FilesystemDirectoryBrowserView>(
    `/filesystem/directories${qs}`,
  );
}

export async function ListHeroes(): Promise<HeroSummaryView[]> {
  const r = await getJSON<{heroes: HeroSummaryView[]}>('/heroes');
  return Array.isArray(r.heroes) ? r.heroes : [];
}

// FEAT-CART-LIB-5 — non-destructive Create Hero entry point.
//
// Mints a fresh anonymous player + entity row via
// `POST /api/heroes`, issues a fresh auth cookie, applies the
// server-authored `clearClientCache` hint so stale session / public
// id keys are dropped, writes the new public id, and resets the
// bridge bootstrap memo so the next `getBridge()` re-fetches player
// + session against the just-created hero. NEVER deletes or
// overwrites any other hero — `createAnonymousPlayer` is insert-only
// on the server side.
//
// The `recovery_code` is returned ONCE — the GUI must show it to
// the user immediately. Once it leaves this callsite the server
// only retains its bcrypt hash.

export interface CreatedHeroResult {
  player: {
    entity_id: number;
    public_id: string;
    display_name: string;
    recovery_code: string;
    profile_created: boolean;
    current_xp: number;
    current_level: number;
    current_hp: number;
    max_hp: number;
    current_location_id: number | null;
    current_scene_id: number | null;
  };
  clearClientCache: ClearClientCacheHint;
}

export async function CreateHero(opts?: {
  displayName?: string;
}): Promise<CreatedHeroResult> {
  const result = await postJSON<CreatedHeroResult>(
    '/heroes',
    opts?.displayName ? {displayName: opts.displayName} : {},
  );
  applyClientCacheReset(result.clearClientCache);
  // The launched hero is server-authoritative — drop the bridge
  // memo so the next caller re-bootstraps from the new identity.
  resetBootstrap();
  return result;
}

// ─── Import preview / apply ───────────────────────────────────────────

interface LibraryMutationCacheReset {
  clearClientCache?: ClearClientCacheHint;
}

export interface DeleteHeroResult extends LibraryMutationCacheReset {
  deleted: true;
  playerId: number;
  sessionsDeleted: number;
}

export async function DeleteHero(opts: {
  playerId: number;
}): Promise<DeleteHeroResult> {
  const result = await deleteJSON<DeleteHeroResult>(
    `/heroes/${encodeURIComponent(String(opts.playerId))}`,
  );
  if (result.clearClientCache) applyClientCacheReset(result.clearClientCache);
  resetBootstrap();
  return result;
}

export interface DeleteCartridgeResult extends LibraryMutationCacheReset {
  deleted: true;
  cartridgeId: string;
  entitiesDeleted: number;
  sessionsDeleted: number;
  playthroughStatesDeleted: number;
  nextDefaultCartridgeId: string | null;
}

export async function DeleteCartridge(opts: {
  cartridgeId: string;
}): Promise<DeleteCartridgeResult> {
  const result = await deleteJSON<DeleteCartridgeResult>(
    `/cartridges/${encodeURIComponent(opts.cartridgeId)}`,
  );
  if (result.clearClientCache) applyClientCacheReset(result.clearClientCache);
  resetBootstrap();
  return result;
}

export interface ResetCartridgeResult extends LibraryMutationCacheReset {
  reset: true;
  cartridgeId: string;
  sessionsDeleted: number;
  playthroughStatesDeleted: number;
}

export async function ResetCartridge(opts: {
  cartridgeId: string;
}): Promise<ResetCartridgeResult> {
  const result = await postJSON<ResetCartridgeResult>(
    `/cartridges/${encodeURIComponent(opts.cartridgeId)}/reset`,
  );
  if (result.clearClientCache) applyClientCacheReset(result.clearClientCache);
  resetBootstrap();
  return result;
}

export type ImportSourceKind = 'obsidian_vault' | 'forge_project' | 'agent_pack';
export type ImportJobStatus =
  | 'queued'
  | 'running'
  | 'ready'
  | 'failed'
  | 'cancelled'
  | 'applying'
  | 'applied';

export interface ImportJobView {
  jobId: string;
  cartridgeId: string | null;
  mode: 'install' | 'reimport' | 'repair' | 'dry_run';
  sourceKind: ImportSourceKind;
  sourcePath: string;
  status: ImportJobStatus;
  phase: string;
  progress: {processed: number; total: number};
  result: {
    cartridgeId: string | null;
    contentHash: string;
    totalRecords: number;
    counts: Record<string, number>;
    validation: {errors: number; warnings: number; items: Array<{level: string; message: string}>};
    diff: {new: number; changed: number; unchanged: number; deprecated: number};
    applyResult?: {
      diff: {new: number; changed: number; unchanged: number; deprecated: number; blocked: number};
      blockedRecordIds: string[];
      deprecatedRecordIds: string[];
    };
  } | null;
  error: {code: string; message: string} | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

export async function CreateImportJob(opts: {
  sourceKind: ImportSourceKind;
  sourcePath: string;
  mode?: 'install' | 'reimport' | 'repair' | 'dry_run';
  cartridgeId?: string;
}): Promise<ImportJobView> {
  return await postJSON<ImportJobView>('/cartridges/import/jobs', opts);
}

export async function GetImportJob(jobId: string): Promise<ImportJobView> {
  return await getJSON<ImportJobView>(
    `/cartridges/import/jobs/${encodeURIComponent(jobId)}`,
  );
}

export async function CancelImportJob(jobId: string): Promise<ImportJobView> {
  return await postJSON<ImportJobView>(
    `/cartridges/import/jobs/${encodeURIComponent(jobId)}/cancel`,
  );
}

export async function ApplyImportJob(opts: {
  jobId: string;
  acceptWarnings?: boolean;
}): Promise<ImportJobView> {
  return await postJSON<ImportJobView>(
    `/cartridges/import/jobs/${encodeURIComponent(opts.jobId)}/apply`,
    {acceptWarnings: opts.acceptWarnings === true},
  );
}

export async function ApplyCartridgeReimport(opts: {
  cartridgeId: string;
  jobId: string;
  acceptWarnings?: boolean;
}): Promise<ImportJobView> {
  return await postJSON<ImportJobView>(
    `/cartridges/${encodeURIComponent(opts.cartridgeId)}/reimport/apply`,
    {jobId: opts.jobId, acceptWarnings: opts.acceptWarnings === true},
  );
}

// ─── Playthrough preview / launch / new-game ──────────────────────────

const playthroughBridge = createPlaythroughBridge({
  postJSON,
  resetBootstrap,
});

export async function PreviewPlaythrough(opts: {
  playerId: number;
  cartridgeId: string;
}): Promise<PlaythroughPreview> {
  return await playthroughBridge.preview(opts);
}

export async function LaunchPlaythrough(opts: {
  playerId: number;
  cartridgeId: string;
}): Promise<PlaythroughLaunchResult> {
  return await playthroughBridge.launch(opts);
}

export async function NewGamePlaythrough(opts: {
  playerId: number;
  cartridgeId: string;
}): Promise<PlaythroughLaunchResult> {
  return await playthroughBridge.newGame(opts);
}

export type {PlaythroughPreview, PlaythroughLaunchResult};
