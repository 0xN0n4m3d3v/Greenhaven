// FEAT-CART-LIB-5 — Worlds & Heroes boot-phase screen.
//
// Three-column dense workbench:
//   * Worlds list (installed cartridges + readiness + content
//     counts + Forge / source path entry).
//   * Heroes list (created players + per-cartridge state) plus a
//     Create Hero affordance that mints a fresh anonymous player
//     server-side, refreshes auth identity, and selects the created
//     hero. Entering a world remains an explicit Launch action.
//   * Compatibility panel — preview mode, blockers, install state,
//     starting / last location, playthrough id + reset generation
//     when present, and the same hero's other recorded cartridge
//     states. Launch / new-game both gated on a non-repair preview.
//
// Server is canon. Create Hero / launch / new-game all route
// through bridge functions that auto-apply the server's
// `clearClientCache` hint and reset the bootstrap memo. Leaf
// fetches / localStorage authority are forbidden in this surface.

import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  CreateHero,
  DeleteCartridge,
  DeleteHero,
  GetLibraryStatus,
  ListCartridges,
  ListHeroes,
  LaunchPlaythrough,
  NewGamePlaythrough,
  PreviewPlaythrough,
  ResetCartridge,
  type CartridgeSummaryView,
  type CreatedHeroResult,
  type HeroSummaryView,
  type LibraryStatusView,
  type PlaythroughPreview,
} from '../../bridge/api';
import type {
  ContinuityCompanionCandidate,
  ContinuityPolicy,
  ContinuityPortableArtifact,
  ContinuityPreview,
  ContinuityWarning,
} from '../../bridge/playthrough';
import {ImportWizard} from './ImportWizard';
import {
  continuityCarryLabel,
  continuityCompanionReasonLabel,
  continuityCompanionStatusLabel,
  continuityLocalLabel,
  continuityWarningLabel,
  libraryText,
  type LibraryText,
} from './labels';
import {CharacterCreator} from '../character/creator/CharacterCreator';

interface Props {
  language: string;
  /** FEAT-ENGINE-BASELINE-6 — server-authored library status. Used to
   *  surface the default generated Forge project as a one-click
   *  import when no cartridge is installed yet. Re-fetched after each
   *  apply so the import button disappears once the world lands. */
  libraryStatus: LibraryStatusView | null;
  onBack: () => void;
  onEnterGame: () => void;
}

interface Selection {
  cartridgeId: string | null;
  playerId: number | null;
}

type StateStatus = 'available' | 'active' | 'incompatible' | 'archived';

function blockerLabel(text: LibraryText, code: string): string {
  switch (code) {
    case 'install_cache_not_ready':
      return text.blockerInstallCacheNotReady;
    case 'hero_incompatible':
      return text.blockerHeroIncompatible;
    case 'no_starting_location':
      return text.blockerNoStartingLocation;
    default:
      return code;
  }
}

function modeLabel(text: LibraryText, mode: PlaythroughMode): string {
  switch (mode) {
    case 'continue':
      return text.modeContinue;
    case 'first_spawn':
      return text.modeFirstSpawn;
    case 'repair_required':
      return text.modeRepair;
  }
}

function stateStatusLabel(text: LibraryText, code: StateStatus): string {
  switch (code) {
    case 'available':
      return text.compatibilityStatusAvailable;
    case 'active':
      return text.compatibilityStatusActive;
    case 'incompatible':
      return text.compatibilityStatusIncompatible;
    case 'archived':
      return text.compatibilityStatusArchived;
  }
}

type PlaythroughMode = PlaythroughPreview['mode'];

type ConfirmAction =
  | {
      kind: 'new-game';
      playerId: number;
      cartridgeId: string;
      heroName: string;
      worldTitle: string;
    }
  | {
      kind: 'reset-world';
      cartridgeId: string;
      worldTitle: string;
    }
  | {
      kind: 'delete-hero';
      playerId: number;
      heroName: string;
    }
  | {
      kind: 'delete-world';
      cartridgeId: string;
      worldTitle: string;
    };

export function WorldsHeroesScreen({
  language,
  libraryStatus,
  onBack,
  onEnterGame,
}: Props) {
  const text = libraryText(language);
  const [cartridges, setCartridges] = useState<CartridgeSummaryView[] | null>(null);
  const [heroes, setHeroes] = useState<HeroSummaryView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<LibraryStatusView | null>(libraryStatus);
  const [selection, setSelection] = useState<Selection>({
    cartridgeId: null,
    playerId: null,
  });
  const [preview, setPreview] = useState<PlaythroughPreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardInitialPath, setWizardInitialPath] = useState<string | null>(null);
  /** FEAT-HERO-CONTINUITY-6 — true when the wizard was opened via the
   *  header "+ Import world…" button. Forces a fresh-import flow so the
   *  wizard does not silently reimport the currently selected cartridge
   *  just because the player happened to have one selected. */
  const [wizardFreshImport, setWizardFreshImport] = useState(false);
  const [createHeroOpen, setCreateHeroOpen] = useState(false);
  const [forgeCopied, setForgeCopied] = useState(false);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);

  const loadLibrary = useCallback(async () => {
    setLoadError(null);
    try {
      const [c, h, s] = await Promise.all([
        ListCartridges(),
        ListHeroes(),
        GetLibraryStatus().catch(() => null),
      ]);
      const playableHeroes = h.filter((row) => row.profileCreated);
      setCartridges(c);
      setHeroes(playableHeroes);
      if (s) setStatus(s);
      setSelection((prev) => {
        const nextCartridge =
          (prev.cartridgeId && c.some((row) => row.id === prev.cartridgeId)
            ? prev.cartridgeId
            : null) ??
          c.find((row) => row.installCache?.ready === true)?.id ??
          c[0]?.id ??
          null;
        const nextPlayer =
          (prev.playerId &&
            playableHeroes.some((row) => row.playerId === prev.playerId)
            ? prev.playerId
            : null) ??
          playableHeroes[0]?.playerId ??
          null;
        return {cartridgeId: nextCartridge, playerId: nextPlayer};
      });
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void loadLibrary();
  }, [loadLibrary]);

  useEffect(() => {
    if (selection.cartridgeId == null || selection.playerId == null) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setPreviewBusy(true);
    setActionError(null);
    void PreviewPlaythrough({
      playerId: selection.playerId,
      cartridgeId: selection.cartridgeId,
    })
      .then((view) => {
        if (!cancelled) setPreview(view);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setPreview(null);
          setActionError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setPreviewBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selection.cartridgeId, selection.playerId]);

  const onLaunch = useCallback(async () => {
    if (selection.playerId == null || selection.cartridgeId == null) return;
    if (actionBusy) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await LaunchPlaythrough({
        playerId: selection.playerId,
        cartridgeId: selection.cartridgeId,
      });
      onEnterGame();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(false);
    }
  }, [selection, actionBusy, onEnterGame]);

  const onImported = useCallback(() => {
    setWizardOpen(false);
    setWizardInitialPath(null);
    setWizardFreshImport(false);
    void loadLibrary();
  }, [loadLibrary]);

  const onCloseWizard = useCallback(() => {
    setWizardOpen(false);
    setWizardInitialPath(null);
    setWizardFreshImport(false);
  }, []);

  // FEAT-ENGINE-BASELINE-6 — surface the default generated Forge
  // project as a one-click import when it's on disk and nothing has
  // been installed yet.
  const onImportDefaultForge = useCallback(() => {
    const path = status?.defaultForgeProject.path;
    if (!path) return;
    setWizardInitialPath(path);
    setWizardOpen(true);
  }, [status]);

  const onCreatedHero = useCallback(async (created: CreatedHeroResult) => {
    setCreateHeroOpen(false);
    setActionError(null);
    await loadLibrary();
    setSelection((prev) => ({
      ...prev,
      playerId: created.player.entity_id,
    }));
  }, [loadLibrary]);

  const onCopyForgePath = useCallback(async (path: string) => {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(path);
        setForgeCopied(true);
        window.setTimeout(() => setForgeCopied(false), 1500);
      }
    } catch {
      /* clipboard unavailable in some sandboxed contexts; the path
       * is still visible inline so the user can copy manually. */
    }
  }, []);

  const selectedCart =
    selection.cartridgeId != null
      ? cartridges?.find((c) => c.id === selection.cartridgeId) ?? null
      : null;
  const selectedHero =
    selection.playerId != null
      ? heroes?.find((h) => h.playerId === selection.playerId) ?? null
      : null;
  const launchable =
    preview != null && preview.mode !== 'repair_required' && !actionBusy;
  const forgePath =
    selectedCart?.source.path ?? selectedCart?.source.generatedFrom ?? null;
  const otherStates =
    selectedHero?.states.filter(
      (s) => s.cartridgeId !== selection.cartridgeId,
    ) ?? [];

  const onNewGame = useCallback(() => {
    if (selection.playerId == null || selection.cartridgeId == null) return;
    if (actionBusy || !selectedHero || !selectedCart) return;
    setConfirmAction({
      kind: 'new-game',
      playerId: selection.playerId,
      cartridgeId: selection.cartridgeId,
      heroName: selectedHero.name,
      worldTitle: selectedCart.title,
    });
  }, [actionBusy, selectedCart, selectedHero, selection]);

  const onResetWorld = useCallback(() => {
    if (selection.cartridgeId == null || !selectedCart || actionBusy) return;
    setConfirmAction({
      kind: 'reset-world',
      cartridgeId: selection.cartridgeId,
      worldTitle: selectedCart.title,
    });
  }, [actionBusy, selectedCart, selection.cartridgeId]);

  const onDeleteHero = useCallback(() => {
    if (selection.playerId == null || !selectedHero || actionBusy) return;
    setConfirmAction({
      kind: 'delete-hero',
      playerId: selection.playerId,
      heroName: selectedHero.name,
    });
  }, [actionBusy, selectedHero, selection.playerId]);

  const onDeleteWorld = useCallback(() => {
    if (selection.cartridgeId == null || !selectedCart || actionBusy) return;
    setConfirmAction({
      kind: 'delete-world',
      cartridgeId: selection.cartridgeId,
      worldTitle: selectedCart.title,
    });
  }, [actionBusy, selectedCart, selection.cartridgeId]);

  const onConfirmAction = useCallback(async () => {
    if (!confirmAction || actionBusy) return;
    setActionBusy(true);
    setActionError(null);
    try {
      switch (confirmAction.kind) {
        case 'new-game':
          await NewGamePlaythrough({
            playerId: confirmAction.playerId,
            cartridgeId: confirmAction.cartridgeId,
          });
          setConfirmAction(null);
          onEnterGame();
          return;
        case 'reset-world':
          await ResetCartridge({cartridgeId: confirmAction.cartridgeId});
          setPreview(null);
          await loadLibrary();
          if (selection.playerId != null) {
            const view = await PreviewPlaythrough({
              playerId: selection.playerId,
              cartridgeId: confirmAction.cartridgeId,
            });
            setPreview(view);
          }
          break;
        case 'delete-hero':
          await DeleteHero({playerId: confirmAction.playerId});
          setPreview(null);
          await loadLibrary();
          break;
        case 'delete-world':
          await DeleteCartridge({cartridgeId: confirmAction.cartridgeId});
          setPreview(null);
          await loadLibrary();
          break;
      }
      setConfirmAction(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(false);
    }
  }, [
    actionBusy,
    confirmAction,
    loadLibrary,
    onEnterGame,
    selection.playerId,
  ]);

  if (createHeroOpen) {
    return (
      <CreateHeroScreen
        text={text}
        onBack={() => setCreateHeroOpen(false)}
        onAcknowledged={onCreatedHero}
      />
    );
  }

  return (
    <main className="cart-lib gh-screen gh-library">
      <header className="cart-lib__head gh-library__topbar">
        <button
          type="button"
          className="cart-lib__btn cart-lib__btn--ghost gh-control gh-library__back"
          onClick={onBack}
        >
          {'<'} {text.back}
        </button>
        <div className="cart-lib__head-title gh-library__title">
          <h1>{text.title}</h1>
          <p>{text.subtitle}</p>
        </div>
        <div className="cart-lib__head-actions gh-library__actions">
          <button
            type="button"
            className="cart-lib__btn cart-lib__btn--ghost gh-control"
            onClick={() => setCreateHeroOpen(true)}
          >
            {text.createHero}
          </button>
          <button
            type="button"
            className="cart-lib__btn cart-lib__btn--ghost gh-control gh-library__import"
            onClick={() => {
              setWizardFreshImport(true);
              setWizardOpen(true);
            }}
          >
            + {text.actionImport}
          </button>
        </div>
      </header>

      {loadError && (
        <p className="cart-lib__error" role="alert">
          {text.error} {loadError}
        </p>
      )}

      <section className="cart-lib__grid cart-lib__grid--gateway gh-library__workspace">
        {/* Worlds column */}
        <div className="cart-lib__col gh-panel gh-library__panel gh-library__worlds" aria-label={text.worldsHeading}>
          <h2 className="cart-lib__col-heading">{text.worldsHeading}</h2>
          {cartridges == null ? (
            <p className="cart-lib__placeholder">{text.loading}</p>
          ) : cartridges.length === 0 ? (
            <div className="cart-lib__empty-library">
              <p className="cart-lib__empty-library-title">
                {text.emptyLibraryTitle}
              </p>
              <p className="cart-lib__empty-library-body">
                {text.emptyLibraryBody}
              </p>
              <DefaultForgePanel
                text={text}
                status={status}
                onImport={onImportDefaultForge}
              />
            </div>
          ) : (
            <ul className="cart-lib__list">
              {cartridges.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    data-cartridge-id={c.id}
                    className={[
                      'cart-lib__card',
                      selection.cartridgeId === c.id
                        ? 'cart-lib__card--selected'
                        : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() =>
                      setSelection((s) => ({...s, cartridgeId: c.id}))
                    }
                  >
                    <div className="cart-lib__card-head">
                      <strong>{c.title}</strong>
                      {c.isDefault && (
                        <span className="cart-lib__badge">{text.defaultBadge}</span>
                      )}
                      <span
                        className={[
                          'cart-lib__pill',
                          c.installCache?.ready
                            ? 'cart-lib__pill--ok'
                            : 'cart-lib__pill--warn',
                        ].join(' ')}
                      >
                        {c.installCache?.ready
                          ? text.installReady
                          : c.installCache?.importRequired
                            ? text.importRequired
                            : text.installNotReady}
                      </span>
                    </div>
                    <dl className="cart-lib__card-meta">
                      <div>
                        <dt>{text.cartridgeVersion}</dt>
                        <dd>{c.version}</dd>
                      </div>
                      <div>
                        <dt>{text.cartridgeContent}</dt>
                        <dd>
                          {c.counts.locations} · {c.counts.people} ·{' '}
                          {c.counts.quests} · {c.counts.scenes} · {c.counts.items}
                        </dd>
                      </div>
                      <div>
                        <dt>{text.cartridgeStartingLocation}</dt>
                        <dd>
                          {c.startingLocationName ?? text.cartridgeNoStart}
                        </dd>
                      </div>
                      <div>
                        <dt>{text.cartridgeValidation}</dt>
                        <dd>
                          {c.validation.errors} / {c.validation.warnings}
                        </dd>
                      </div>
                    </dl>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Heroes column */}
        <div className="cart-lib__col gh-panel gh-library__panel gh-library__heroes" aria-label={text.heroesHeading}>
          <div className="cart-lib__col-heading-row">
            <h2 className="cart-lib__col-heading">{text.heroesHeading}</h2>
          </div>
          {heroes == null ? (
            <p className="cart-lib__placeholder">{text.loading}</p>
          ) : heroes.length === 0 ? (
            <p className="cart-lib__placeholder">{text.noHeroes}</p>
          ) : (
            <ul className="cart-lib__list">
              {heroes.map((h) => (
                <li key={h.playerId}>
                  <button
                    type="button"
                    className={[
                      'cart-lib__card',
                      selection.playerId === h.playerId
                        ? 'cart-lib__card--selected'
                        : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() =>
                      setSelection((s) => ({...s, playerId: h.playerId}))
                    }
                  >
                    <div className="cart-lib__card-head">
                      <strong>{h.name}</strong>
                      <span className="cart-lib__badge cart-lib__badge--muted">
                        {text.heroLevel} {h.level}
                      </span>
                    </div>
                    <dl className="cart-lib__card-meta">
                      <div>
                        <dt>{text.heroLastSeen}</dt>
                        <dd>
                          {h.lastSeenAt
                            ? new Date(h.lastSeenAt).toLocaleDateString(
                                language || 'en',
                              )
                            : '—'}
                        </dd>
                      </div>
                      <div>
                        <dt>{text.heroCurrentWorld}</dt>
                        <dd>{h.currentCartridgeId ?? text.heroNoCartridge}</dd>
                      </div>
                      <div>
                        <dt>{text.heroVisitedWorlds}</dt>
                        <dd>
                          {h.states.length > 0
                            ? h.states.length
                            : text.heroVisitedWorldsNone}
                        </dd>
                      </div>
                    </dl>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Entry / compatibility panel */}
        <div
          className="cart-lib__col cart-lib__col--gateway gh-panel gh-library__panel gh-library__launch"
          aria-label={text.enterGame}
        >
          <h2 className="cart-lib__col-heading">{text.enterGame}</h2>
          {selectedCart == null || selectedHero == null ? (
            <div className="cart-lib__gateway cart-lib__gateway--empty">
              <div className="cart-lib__gateway-pair" aria-hidden>
                <div className="cart-lib__gateway-slot">
                  <span>{text.compatibilityWorld}</span>
                  <strong>{selectedCart?.title ?? text.worldsHeading}</strong>
                </div>
                <div className="cart-lib__gateway-link">+</div>
                <div className="cart-lib__gateway-slot">
                  <span>{text.compatibilityHero}</span>
                  <strong>{selectedHero?.name ?? text.heroesHeading}</strong>
                </div>
              </div>
              <p className="cart-lib__gateway-status">
                {selectedCart == null
                  ? text.blockerInstallCacheNotReady
                  : text.noHeroes}
              </p>
            </div>
          ) : previewBusy ? (
            <div className="cart-lib__gateway cart-lib__gateway--empty">
              <p className="cart-lib__gateway-status">{text.previewLoading}</p>
            </div>
          ) : preview == null ? (
            <div className="cart-lib__gateway cart-lib__gateway--empty">
              <p className="cart-lib__gateway-status">—</p>
            </div>
          ) : (
            <div className="cart-lib__preview">
              <div
                className={[
                  'cart-lib__gateway',
                  preview.mode === 'repair_required'
                    ? 'cart-lib__gateway--blocked'
                    : 'cart-lib__gateway--ready',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                <div className="cart-lib__gateway-mode">
                  <span>{modeLabel(text, preview.mode)}</span>
                  {preview.installReady && <em>{text.installReady}</em>}
                </div>
                <div className="cart-lib__gateway-pair">
                  <div className="cart-lib__gateway-slot">
                    <span>{text.compatibilityWorld}</span>
                    <strong>{selectedCart.title}</strong>
                    <small>
                      {preview.startingLocationName ?? text.cartridgeNoStart}
                    </small>
                  </div>
                  <div className="cart-lib__gateway-link">+</div>
                  <div className="cart-lib__gateway-slot">
                    <span>{text.compatibilityHero}</span>
                    <strong>{selectedHero.name}</strong>
                    <small>
                      {text.heroLevel} {selectedHero.level}
                    </small>
                  </div>
                </div>
                <div className="cart-lib__actions cart-lib__actions--gateway">
                  <button
                    type="button"
                    className="cart-lib__btn cart-lib__btn--primary cart-lib__btn--enter"
                    onClick={onLaunch}
                    disabled={!launchable || previewBusy}
                  >
                    {text.actionLaunch}
                  </button>
                  <button
                    type="button"
                    className="cart-lib__btn"
                    onClick={onNewGame}
                    disabled={
                      !launchable ||
                      previewBusy ||
                      !selectedCart.startingLocationName
                    }
                  >
                    {text.actionNewGame}
                  </button>
                  <button
                    type="button"
                    className="cart-lib__btn cart-lib__btn--ghost"
                    onClick={() => setWizardOpen(true)}
                  >
                    {text.actionReimport}
                  </button>
                </div>
                <div className="cart-lib__actions cart-lib__actions--danger">
                  <button
                    type="button"
                    className="cart-lib__btn cart-lib__btn--danger"
                    onClick={onResetWorld}
                    disabled={actionBusy || previewBusy}
                  >
                    {text.actionResetWorld}
                  </button>
                  <button
                    type="button"
                    className="cart-lib__btn cart-lib__btn--danger"
                    onClick={onDeleteHero}
                    disabled={actionBusy || previewBusy}
                  >
                    {text.actionDeleteHero}
                  </button>
                  <button
                    type="button"
                    className="cart-lib__btn cart-lib__btn--danger"
                    onClick={onDeleteWorld}
                    disabled={actionBusy || previewBusy}
                  >
                    {text.actionDeleteWorld}
                  </button>
                </div>
                {actionError && (
                  <p className="cart-lib__error" role="alert">
                    {actionError}
                  </p>
                )}
              </div>
              <dl className="cart-lib__compat-meta">
                <div>
                  <dt>{text.compatibilityHero}</dt>
                  <dd>{selectedHero.name}</dd>
                </div>
                <div>
                  <dt>{text.compatibilityWorld}</dt>
                  <dd>{selectedCart.title}</dd>
                </div>
                <div>
                  <dt>{text.compatibilityMode}</dt>
                  <dd
                    className={
                      preview.mode === 'repair_required'
                        ? 'cart-lib__preview-mode--repair'
                        : ''
                    }
                  >
                    {modeLabel(text, preview.mode)}
                  </dd>
                </div>
                <div>
                  <dt>{text.compatibilityInstallState}</dt>
                  <dd>
                    {preview.installState ?? '—'}
                    {preview.installReady ? ` · ${text.installReady}` : ''}
                  </dd>
                </div>
                <div>
                  <dt>{text.compatibilityStartingLocation}</dt>
                  <dd>
                    {preview.startingLocationName ?? text.cartridgeNoStart}
                  </dd>
                </div>
                {preview.state && (
                  <>
                    <div>
                      <dt>{text.compatibilityLastLocation}</dt>
                      <dd>{preview.state.currentLocationName ?? '—'}</dd>
                    </div>
                    <div>
                      <dt>{text.compatibilityResetGeneration}</dt>
                      <dd>{preview.state.resetGeneration}</dd>
                    </div>
                    <div>
                      <dt>{text.compatibilityPlaythroughId}</dt>
                      <dd className="cart-lib__compat-mono">
                        {preview.state.playthroughId.slice(0, 8)}…
                      </dd>
                    </div>
                    {preview.state.lastSessionId && (
                      <div>
                        <dt>{text.compatibilityLastSession}</dt>
                        <dd className="cart-lib__compat-mono">
                          {preview.state.lastSessionId.slice(0, 12)}…
                        </dd>
                      </div>
                    )}
                  </>
                )}
              </dl>
              {preview.continuityPreview && (
                <ContinuitySections
                  text={text}
                  continuity={preview.continuityPreview}
                  blockers={preview.blockers}
                  mode={preview.mode}
                  state={preview.state}
                />
              )}
              {preview.mode === 'repair_required' && (
                <div className="cart-lib__compat-blockers">
                  <p className="cart-lib__compat-section-title">
                    {text.compatibilityBlockers}
                  </p>
                  <ul className="cart-lib__blockers">
                    {preview.blockers.map((b) => (
                      <li key={b}>{blockerLabel(text, b)}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="cart-lib__compat-other">
                <p className="cart-lib__compat-section-title">
                  {text.compatibilityOtherWorlds}
                </p>
                {otherStates.length === 0 ? (
                  <p className="cart-lib__placeholder">
                    {text.compatibilityNoOtherWorlds}
                  </p>
                ) : (
                  <ul className="cart-lib__compat-other-list">
                    {otherStates.map((s) => (
                      <li key={s.cartridgeId}>
                        <span className="cart-lib__compat-other-cart">
                          {s.cartridgeId}
                        </span>
                        <span className="cart-lib__compat-other-status">
                          {stateStatusLabel(text, s.status as StateStatus)}
                        </span>
                        <span className="cart-lib__compat-other-loc">
                          {s.lastLocationName ?? '—'}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="cart-lib__compat-forge">
                <p className="cart-lib__compat-section-title">
                  {text.forgeHeading}
                </p>
                <p className="cart-lib__compat-forge-desc">
                  {text.forgeDescription}
                </p>
                {forgePath ? (
                  <div className="cart-lib__compat-forge-path">
                    <code title={forgePath}>{forgePath}</code>
                    <button
                      type="button"
                      className="cart-lib__btn cart-lib__btn--ghost cart-lib__btn--sm"
                      onClick={() => void onCopyForgePath(forgePath)}
                    >
                      {forgeCopied ? text.forgeCopied : text.forgeCopyPath}
                    </button>
                  </div>
                ) : (
                  <p className="cart-lib__placeholder">{text.forgeNoPath}</p>
                )}
              </div>
              <p className="cart-lib__continuity-note cart-lib__continuity-note--new-game">
                {text.newGameCarryoverNote}
              </p>
              <p className="cart-lib__continuity-note cart-lib__continuity-note--reimport">
                {text.reimportCarryoverNote}
              </p>
            </div>
          )}
        </div>
      </section>

      {wizardOpen && (
        <ImportWizard
          text={text}
          reimportCartridgeId={
            wizardInitialPath || wizardFreshImport ? null : selection.cartridgeId
          }
          initialSourcePath={wizardInitialPath}
          onClose={onCloseWizard}
          onApplied={onImported}
        />
      )}

      {confirmAction && (
        <ConfirmActionModal
          text={text}
          action={confirmAction}
          busy={actionBusy}
          onCancel={() => setConfirmAction(null)}
          onConfirm={() => void onConfirmAction()}
        />
      )}
    </main>
  );
}

// FEAT-HERO-CONTINUITY-5 — server-owned continuity panel. Lists what
// the hero carries into the target world, what stays in this world,
// what this world adjusts/suppresses, and companion carryover status.
// All copy comes from `LibraryText` labels keyed on stable backend
// codes; unknown codes fall through to the raw string so a future
// backend addition stays legible.

interface ContinuitySectionsProps {
  text: LibraryText;
  continuity: ContinuityPreview;
  blockers: string[];
  mode: PlaythroughMode;
  state: PlaythroughPreview['state'];
}

interface AdjustedRow {
  key: string;
  label: string;
}

function buildAdjustedRows(
  text: LibraryText,
  continuity: ContinuityPreview,
  blockers: string[],
): AdjustedRow[] {
  const rows: AdjustedRow[] = [];
  for (const warning of continuity.warnings as ContinuityWarning[]) {
    rows.push({
      key: `warn:${warning.code}`,
      label: continuityWarningLabel(text, warning.code),
    });
  }
  for (const artifact of continuity.portableArtifacts as ContinuityPortableArtifact[]) {
    if (artifact.portability !== 'portable') {
      rows.push({
        key: `artifact:${artifact.artifactKey}`,
        label: `${text.warningSuppressedArtifact} (${artifact.artifactKey})`,
      });
    }
  }
  const policy: ContinuityPolicy = continuity.policy;
  if (policy.carry.companions === 'portable_contracts') {
    rows.push({
      key: 'policy:companions_portable',
      label: text.policyCompanionsPortableAllowed,
    });
  } else if (policy.carry.companions === 'local_only' && policy.isDefault) {
    rows.push({
      key: 'policy:companions_local_default',
      label: text.policyDefaultCompanionsLocal,
    });
  }
  if (policy.carry.memories === 'summary_only') {
    rows.push({
      key: 'policy:memories_summary',
      label: text.policyDefaultMemoriesSummary,
    });
  }
  if (blockers.includes('no_starting_location')) {
    rows.push({
      key: 'blocker:no_starting_location',
      label: text.policyMissingStartingLocation,
    });
  }
  return rows;
}

function ContinuitySections({
  text,
  continuity,
  blockers,
  mode,
  state,
}: ContinuitySectionsProps) {
  const carries = continuity.carriesWithHero;
  const hasPortable = continuity.portableArtifacts.some(
    (a) => a.portability === 'portable',
  );
  const stays = continuity.staysInSourceWorld.filter((row) => row.nonEmpty);
  const adjusted = useMemo(
    () => buildAdjustedRows(text, continuity, blockers),
    [text, continuity, blockers],
  );
  const companions = continuity.companionCandidates;

  // Empty-state heading — "First arrival" vs "Returning" — mirrors the
  // frontend spec's UX guidance.
  const arrivalKey =
    state == null
      ? text.continuityFirstArrival
      : mode === 'continue'
        ? text.continuityReturning
        : text.continuityFirstArrival;

  return (
    <section
      className="cart-lib__continuity"
      aria-label={text.continuityHeading}
      data-continuity-schema={continuity.schemaVersion}
    >
      <header className="cart-lib__continuity-head">
        <p className="cart-lib__compat-section-title">{text.continuityHeading}</p>
        <span className="cart-lib__continuity-arrival">{arrivalKey}</span>
      </header>

      <div
        className="cart-lib__continuity-section cart-lib__continuity-section--carry"
        aria-label={text.continuityCarriesHeading}
        data-continuity-kind="carries"
      >
        <p className="cart-lib__continuity-section-title">
          {text.continuityCarriesHeading}
        </p>
        <ul className="cart-lib__continuity-rows">
          {carries.map((row) => (
            <li key={`carry:${row.code}`} className="cart-lib__continuity-row">
              <span className="cart-lib__continuity-row-badge cart-lib__continuity-row-badge--carry">
                {continuityCarryLabel(text, row.code)}
              </span>
              <span className="cart-lib__continuity-row-meta">{row.summary}</span>
            </li>
          ))}
          {hasPortable && (
            <li
              key="carry:portable_artifacts"
              className="cart-lib__continuity-row"
            >
              <span className="cart-lib__continuity-row-badge cart-lib__continuity-row-badge--carry">
                {text.carryPortableArtifacts}
              </span>
              <span className="cart-lib__continuity-row-meta">
                {
                  continuity.portableArtifacts.filter(
                    (a) => a.portability === 'portable',
                  ).length
                }
              </span>
            </li>
          )}
          {carries.length === 0 && !hasPortable && (
            <li className="cart-lib__continuity-empty">
              {text.continuityNoCarries}
            </li>
          )}
        </ul>
      </div>

      <div
        className="cart-lib__continuity-section cart-lib__continuity-section--stays"
        aria-label={text.continuityStaysHeading}
        data-continuity-kind="stays"
      >
        <p className="cart-lib__continuity-section-title">
          {text.continuityStaysHeading}
        </p>
        <ul className="cart-lib__continuity-rows">
          {stays.length === 0 ? (
            <li className="cart-lib__continuity-empty">
              {text.continuityNoStays}
            </li>
          ) : (
            stays.map((row) => (
              <li
                key={`stays:${row.code}`}
                className="cart-lib__continuity-row"
              >
                <span className="cart-lib__continuity-row-badge cart-lib__continuity-row-badge--local">
                  {continuityLocalLabel(text, row.code)}
                </span>
                <span className="cart-lib__continuity-row-meta">{row.count}</span>
              </li>
            ))
          )}
        </ul>
      </div>

      <div
        className="cart-lib__continuity-section cart-lib__continuity-section--adjusted"
        aria-label={text.continuityAdjustedHeading}
        data-continuity-kind="adjusted"
      >
        <p className="cart-lib__continuity-section-title">
          {text.continuityAdjustedHeading}
        </p>
        <ul className="cart-lib__continuity-rows">
          {adjusted.length === 0 ? (
            <li className="cart-lib__continuity-empty">
              {text.continuityNoAdjustments}
            </li>
          ) : (
            adjusted.map((row) => (
              <li key={row.key} className="cart-lib__continuity-row">
                <span className="cart-lib__continuity-row-badge cart-lib__continuity-row-badge--adjusted">
                  •
                </span>
                <span className="cart-lib__continuity-row-meta">{row.label}</span>
              </li>
            ))
          )}
        </ul>
      </div>

      <div
        className="cart-lib__continuity-section cart-lib__continuity-section--companions"
        aria-label={text.continuityCompanionsHeading}
        data-continuity-kind="companions"
      >
        <p className="cart-lib__continuity-section-title">
          {text.continuityCompanionsHeading}
        </p>
        {companions.length === 0 ? (
          <p className="cart-lib__continuity-empty">
            {text.continuityNoCompanions}
          </p>
        ) : (
          <ul className="cart-lib__companion-rows">
            {companions.map((candidate: ContinuityCompanionCandidate) => (
              <li
                key={`companion:${candidate.sourceEntityId}`}
                className="cart-lib__companion-row"
                data-companion-status={candidate.status}
              >
                <span className="cart-lib__companion-name">
                  {candidate.displayName}
                </span>
                <span
                  className={`cart-lib__companion-status cart-lib__companion-status--${candidate.status}`}
                >
                  {continuityCompanionStatusLabel(text, candidate.status)}
                </span>
                <span className="cart-lib__companion-reason">
                  {continuityCompanionReasonLabel(text, candidate.reason)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

interface DefaultForgePanelProps {
  text: LibraryText;
  status: LibraryStatusView | null;
  onImport: () => void;
}

function DefaultForgePanel({text, status, onImport}: DefaultForgePanelProps) {
  const forge = status?.defaultForgeProject ?? null;
  return (
    <section className="cart-lib__default-forge" aria-label={text.defaultForgeHeading}>
      <p className="cart-lib__compat-section-title">{text.defaultForgeHeading}</p>
      {forge?.available ? (
        <>
          <p className="cart-lib__default-forge-body">{text.defaultForgeReady}</p>
          <code className="cart-lib__default-forge-path" title={forge.path}>
            {forge.path}
          </code>
          <button
            type="button"
            className="cart-lib__btn cart-lib__btn--primary"
            onClick={onImport}
          >
            {text.defaultForgeImport}
          </button>
        </>
      ) : (
        <p className="cart-lib__placeholder">{text.defaultForgeMissing}</p>
      )}
    </section>
  );
}

interface ConfirmActionModalProps {
  text: LibraryText;
  action: ConfirmAction;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

function ConfirmActionModal({
  text,
  action,
  busy,
  onCancel,
  onConfirm,
}: ConfirmActionModalProps) {
  const title =
    action.kind === 'new-game'
      ? text.confirmNewGameTitle
      : action.kind === 'reset-world'
        ? text.confirmResetWorldTitle
        : action.kind === 'delete-hero'
          ? text.confirmDeleteHeroTitle
          : text.confirmDeleteWorldTitle;
  const body =
    action.kind === 'new-game'
      ? text.newGameConfirm
      : action.kind === 'reset-world'
        ? text.confirmResetWorldBody
        : action.kind === 'delete-hero'
          ? text.confirmDeleteHeroBody
          : text.confirmDeleteWorldBody;
  const confirmLabel =
    action.kind === 'new-game'
      ? text.actionNewGame
      : action.kind === 'reset-world'
        ? text.actionResetWorld
        : action.kind === 'delete-hero'
          ? text.actionDeleteHero
          : text.actionDeleteWorld;
  const target =
    action.kind === 'delete-hero'
      ? action.heroName
      : action.kind === 'new-game'
        ? `${action.heroName} / ${action.worldTitle}`
        : action.worldTitle;
  return (
    <div className="cart-lib__wizard-backdrop" role="dialog" aria-modal="true">
      <div className="cart-lib__wizard cart-lib__wizard--confirm">
        <header className="cart-lib__wizard-head">
          <h2>{title}</h2>
          <button
            type="button"
            className="cart-lib__btn cart-lib__btn--ghost"
            onClick={onCancel}
            aria-label={text.importClose}
            disabled={busy}
          >
            x
          </button>
        </header>
        <div className="cart-lib__wizard-body">
          <p className="cart-lib__wizard-copy">{body}</p>
          <p className="cart-lib__confirm-target">{target}</p>
        </div>
        <footer className="cart-lib__wizard-foot">
          <button
            type="button"
            className="cart-lib__btn cart-lib__btn--ghost"
            onClick={onCancel}
            disabled={busy}
          >
            {text.confirmCancel}
          </button>
          <button
            type="button"
            className={[
              'cart-lib__btn',
              action.kind === 'new-game'
                ? 'cart-lib__btn--primary'
                : 'cart-lib__btn--danger',
            ].join(' ')}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? text.confirmBusy : confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}

interface CreateHeroScreenProps {
  text: LibraryText;
  onBack: () => void;
  onAcknowledged: (created: CreatedHeroResult) => void | Promise<void>;
}

function CreateHeroScreen({text, onBack, onAcknowledged}: CreateHeroScreenProps) {
  const [busy, setBusy] = useState(true);
  const [created, setCreated] = useState<CreatedHeroResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const createdRef = useRef<CreatedHeroResult | null>(null);
  const completedRef = useRef(false);
  const closeRequestedRef = useRef(false);
  const mountedRef = useRef(false);

  const createDraft = useCallback(async () => {
    if (!mountedRef.current) return;
    setBusy(true);
    setErrorMessage(null);
    try {
      const result = await CreateHero();
      if (closeRequestedRef.current || !mountedRef.current) {
        await DeleteHero({playerId: result.player.entity_id}).catch(() => {});
        return;
      }
      createdRef.current = result;
      setCreated(result);
    } catch (err) {
      if (mountedRef.current) {
        setErrorMessage(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void createDraft();
    return () => {
      mountedRef.current = false;
      const draft = createdRef.current;
      if (draft && !completedRef.current) {
        void DeleteHero({playerId: draft.player.entity_id}).catch(() => {});
      }
    };
  }, [createDraft]);

  const close = useCallback(() => {
    closeRequestedRef.current = true;
    const draft = createdRef.current;
    createdRef.current = null;
    if (draft && !completedRef.current) {
      setBusy(true);
      void DeleteHero({playerId: draft.player.entity_id})
        .catch(() => {})
        .finally(onBack);
      return;
    }
    onBack();
  }, [onBack]);

  const complete = useCallback(async () => {
    if (!created) return;
    completedRef.current = true;
    await onAcknowledged(created);
  }, [created, onAcknowledged]);

  const title = !created
    ? text.createHeroSheetTitle
    : text.createHeroSheetTitle;
  const phase = created ? '1 / 1' : '...';
  const subtitle = !created
    ? text.createHeroBusy
    : text.createHeroSheetCommit;

  return (
    <main
      className={`hero-creator-screen gh-screen${
        created ? ' hero-creator-screen--sheet' : ''
      }`}
    >
      <header className="hero-creator-screen__topbar">
        <button
          type="button"
          className="cart-lib__btn cart-lib__btn--ghost gh-control hero-creator-screen__back"
          onClick={close}
        >
          {'<'} {text.back}
        </button>
        <div className="hero-creator-screen__title">
          <span className="cart-lib__wizard-phase">{phase}</span>
          <div>
            <h2>{title}</h2>
            <p>{subtitle}</p>
          </div>
        </div>
      </header>

      {!created ? (
        <section className="hero-creator-screen__workspace">
          <div className="hero-creator-screen__panel">
            <div className="hero-creator-screen__copy">
              <span className="cart-lib__hero-start-label">Character sheet</span>
              <h3>{text.createHeroSheetTitle}</h3>
              <p>{errorMessage ? text.error : text.createHeroBusy}</p>
              {errorMessage && (
                <p className="cart-lib__wizard-error" role="alert">
                  {errorMessage}
                </p>
              )}
            </div>
            <div className="hero-creator-screen__actions">
              <button
                type="button"
                className="cart-lib__btn cart-lib__btn--ghost"
                onClick={close}
              >
                {text.createHeroCancel}
              </button>
              <button
                type="button"
                className="cart-lib__btn cart-lib__btn--primary"
                onClick={() => void createDraft()}
                disabled={busy || !errorMessage}
              >
                {busy ? text.createHeroBusy : text.createHeroSubmit}
              </button>
            </div>
          </div>
        </section>
      ) : (
        <section className="hero-creator-screen__creator-frame">
          <CharacterCreator
            playerId={created.player.entity_id}
            onComplete={() => void complete()}
            embedded
            commitLabelOverride={text.createHeroSheetCommit}
          />
        </section>
      )}
    </main>
  );
}
