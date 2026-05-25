// FEAT-CART-LIB-5 — compact import / reimport wizard.
//
// Boot-phase modal driven by the bridge module:
//   1. Operator picks source kind + path (+ optional target cartridge
//      id for reimport — we pass it for the URL-mismatch guard).
//   2. POST /api/cartridges/import/jobs → preview job runs.
//   3. We poll GET /api/cartridges/import/jobs/:jobId until terminal
//      (`ready` | `failed` | `cancelled`).
//   4. On `ready`: render diff + validation. If validation.errors > 0,
//      Apply stays disabled (the service rejects it anyway). If
//      validation.warnings > 0, the operator must check "Accept
//      warnings". Apply uses `/cartridges/:id/reimport/apply` when
//      `reimportCartridgeId` is set so the URL-mismatch guard fires.
//   5. Cancel kills the running preview cleanly before apply.
//
// This is intentionally a workbench dialog, not a marketing wizard.
// No fancy progress bar; one clear status block + actions.

import {useCallback, useEffect, useRef, useState} from 'react';
import {
  ApplyCartridgeReimport,
  ApplyImportJob,
  BrowseFilesystemDirectories,
  CancelImportJob,
  CreateImportJob,
  GetImportJob,
  type FilesystemDirectoryBrowserView,
  type FilesystemDirectoryEntryView,
  type ImportJobView,
  type ImportSourceKind,
} from '../../bridge/api';
import {
  hasDesktopDirectoryPicker,
  selectDesktopDirectory,
} from '../../lib/desktopConfig';
import {jobStatusLabel, type LibraryText} from './labels';

interface Props {
  text: LibraryText;
  /** When set, apply is routed through
   *  `/cartridges/:id/reimport/apply` so the URL-mismatch guard
   *  protects the operator from applying against the wrong cartridge. */
  reimportCartridgeId: string | null;
  /** FEAT-ENGINE-BASELINE-6 — pre-fill the source path field. Used by
   *  the Worlds & Heroes "Import default world" one-click button so
   *  the operator does not have to paste the generated Forge project
   *  path. */
  initialSourcePath?: string | null;
  onClose: () => void;
  /** Called after a successful apply so the parent can refresh
   *  cartridges/heroes/preview. */
  onApplied: (view: ImportJobView) => void;
}

const TERMINAL_PREVIEW: ReadonlySet<ImportJobView['status']> = new Set([
  'ready',
  'failed',
  'cancelled',
]);

const POLL_INTERVAL_MS = 800;

function initialImportSourceKind(path: string | null | undefined): ImportSourceKind {
  const normalized = (path ?? '').replace(/\\/g, '/').toLowerCase();
  if (
    normalized.endsWith('/.greenhaven-agent-manual/generated/cartridge-forge-project') ||
    normalized.includes('/.greenhaven-agent-manual/generated/cartridge-forge-project/')
  ) {
    return 'forge_project';
  }
  return 'obsidian_vault';
}

export function ImportWizard({
  text,
  reimportCartridgeId,
  initialSourcePath,
  onClose,
  onApplied,
}: Props) {
  const [sourceKind, setSourceKind] = useState<ImportSourceKind>(() =>
    initialImportSourceKind(initialSourcePath),
  );
  const [sourcePath, setSourcePath] = useState(initialSourcePath ?? '');
  const [job, setJob] = useState<ImportJobView | null>(null);
  const [busy, setBusy] = useState(false);
  const [browseBusy, setBrowseBusy] = useState(false);
  const [directoryBrowser, setDirectoryBrowser] =
    useState<FilesystemDirectoryBrowserView | null>(null);
  const [acceptWarnings, setAcceptWarnings] = useState(false);
  const [appliedView, setAppliedView] = useState<ImportJobView | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const pollTimer = useRef<number | null>(null);
  const importLocked = job?.status === 'running' || job?.status === 'queued';

  const stopPoll = useCallback(() => {
    if (pollTimer.current != null) {
      window.clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  useEffect(() => stopPoll, [stopPoll]);

  const beginPolling = useCallback(
    (jobId: string) => {
      stopPoll();
      pollTimer.current = window.setInterval(async () => {
        try {
          const view = await GetImportJob(jobId);
          setJob(view);
          if (TERMINAL_PREVIEW.has(view.status)) stopPoll();
        } catch (err) {
          stopPoll();
          setErrorMessage(err instanceof Error ? err.message : String(err));
        }
      }, POLL_INTERVAL_MS);
    },
    [stopPoll],
  );

  const onCreate = useCallback(async () => {
    if (busy || !sourcePath.trim()) return;
    setBusy(true);
    setErrorMessage(null);
    setAppliedView(null);
    setAcceptWarnings(false);
    try {
      const created = await CreateImportJob({
        sourceKind,
        sourcePath: sourcePath.trim(),
        mode: reimportCartridgeId ? 'reimport' : 'install',
        ...(reimportCartridgeId ? {cartridgeId: reimportCartridgeId} : {}),
      });
      setJob(created);
      beginPolling(created.jobId);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [busy, sourceKind, sourcePath, reimportCartridgeId, beginPolling]);

  const openServerDirectoryBrowser = useCallback(async (nextPath?: string) => {
    setBrowseBusy(true);
    setErrorMessage(null);
    try {
      const view = await BrowseFilesystemDirectories(nextPath);
      setDirectoryBrowser(view);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBrowseBusy(false);
    }
  }, []);

  const onBrowseSourcePath = useCallback(async () => {
    if (browseBusy || importLocked) return;
    if (!hasDesktopDirectoryPicker()) {
      await openServerDirectoryBrowser(sourcePath.trim() || undefined);
      return;
    }
    setBrowseBusy(true);
    setErrorMessage(null);
    try {
      const selected = await selectDesktopDirectory({
        title: text.importBrowseTitle,
        defaultPath: sourcePath.trim() || undefined,
      });
      if (!selected.available) {
        await openServerDirectoryBrowser(sourcePath.trim() || undefined);
        return;
      }
      if (selected.error) {
        setErrorMessage(`${text.importBrowseUnavailable} ${selected.error}`);
        await openServerDirectoryBrowser(sourcePath.trim() || undefined);
        return;
      }
      if (!selected.canceled && selected.path) {
        setSourcePath(selected.path);
        setSourceKind(initialImportSourceKind(selected.path));
      }
    } finally {
      setBrowseBusy(false);
    }
  }, [
    browseBusy,
    importLocked,
    openServerDirectoryBrowser,
    sourcePath,
    text.importBrowseTitle,
    text.importBrowseUnavailable,
  ]);

  const onUseDirectory = useCallback((target: string) => {
    setSourcePath(target);
    setSourceKind(initialImportSourceKind(target));
    setDirectoryBrowser(null);
  }, []);

  const onCancel = useCallback(async () => {
    if (!job) return;
    try {
      const view = await CancelImportJob(job.jobId);
      setJob(view);
      stopPoll();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    }
  }, [job, stopPoll]);

  const onApply = useCallback(async () => {
    if (!job || job.status !== 'ready') return;
    setBusy(true);
    setErrorMessage(null);
    try {
      const applied = reimportCartridgeId
        ? await ApplyCartridgeReimport({
            cartridgeId: reimportCartridgeId,
            jobId: job.jobId,
            acceptWarnings,
          })
        : await ApplyImportJob({jobId: job.jobId, acceptWarnings});
      setAppliedView(applied);
      setJob(applied);
      onApplied(applied);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [job, reimportCartridgeId, acceptWarnings, onApplied]);

  const validation = job?.result?.validation;
  const diff = appliedView?.result?.applyResult?.diff ?? job?.result?.diff ?? null;
  const errors = validation?.errors ?? 0;
  const warnings = validation?.warnings ?? 0;
  const canApply =
    job?.status === 'ready' &&
    errors === 0 &&
    (warnings === 0 || acceptWarnings) &&
    !appliedView;

  return (
    <div className="cart-lib__wizard-backdrop" role="dialog" aria-modal="true">
      <div className="cart-lib__wizard">
        <header className="cart-lib__wizard-head">
          <h2>{text.importTitle}</h2>
          <button
            type="button"
            className="cart-lib__btn cart-lib__btn--ghost"
            onClick={onClose}
            aria-label={text.importClose}
          >
            ×
          </button>
        </header>

        <div className="cart-lib__wizard-body">
          <label className="cart-lib__field">
            <span>{text.importSourceKind}</span>
            <select
              value={sourceKind}
              onChange={(e) => setSourceKind(e.target.value as ImportSourceKind)}
              disabled={importLocked}
            >
              <option value="obsidian_vault">{text.importSourceKindObsidian}</option>
              <option value="forge_project">{text.importSourceKindForge}</option>
              <option value="agent_pack">{text.importSourceKindAgent}</option>
            </select>
          </label>

          <div className="cart-lib__field">
            <span>{text.importSourcePath}</span>
            <div className="cart-lib__field-row">
              <input
                type="text"
                value={sourcePath}
                onChange={(e) => setSourcePath(e.target.value)}
                placeholder={text.importPathPlaceholder}
                disabled={importLocked}
                spellCheck={false}
              />
              <button
                type="button"
                className="cart-lib__btn cart-lib__btn--ghost cart-lib__btn--browse"
                onClick={onBrowseSourcePath}
                disabled={importLocked || browseBusy}
              >
                {browseBusy ? text.importBrowseBusy : text.importBrowse}
              </button>
            </div>
          </div>

          {directoryBrowser && (
            <section className="cart-lib__folder-browser">
              <header className="cart-lib__folder-browser-head">
                <div>
                  <h3>{text.importFolderBrowserHeading}</h3>
                  <code>{directoryBrowser.currentPath}</code>
                </div>
                <button
                  type="button"
                  className="cart-lib__btn cart-lib__btn--primary cart-lib__btn--sm"
                  onClick={() => onUseDirectory(directoryBrowser.currentPath)}
                >
                  {text.importFolderBrowserUseCurrent}
                </button>
              </header>
              <div className="cart-lib__folder-browser-list">
                {directoryBrowser.parentPath && (
                  <button
                    type="button"
                    className="cart-lib__folder-browser-row"
                    onClick={() =>
                      openServerDirectoryBrowser(
                        directoryBrowser.parentPath ?? undefined,
                      )
                    }
                    disabled={browseBusy}
                  >
                    <span>..</span>
                    <small>{text.importFolderBrowserParent}</small>
                  </button>
                )}
                {directoryBrowser.entries.length === 0 ? (
                  <p className="cart-lib__folder-browser-empty">
                    {text.importFolderBrowserEmpty}
                  </p>
                ) : (
                  directoryBrowser.entries.map(
                    (entry: FilesystemDirectoryEntryView) => (
                      <button
                        type="button"
                        key={entry.path}
                        className="cart-lib__folder-browser-row"
                        onClick={() => openServerDirectoryBrowser(entry.path)}
                        disabled={browseBusy}
                      >
                        <span>{entry.name}</span>
                        <small>
                          {entry.forgeProject
                            ? text.importFolderBrowserForge
                            : entry.obsidianVault
                              ? text.importFolderBrowserCandidate
                              : entry.path}
                        </small>
                      </button>
                    ),
                  )
                )}
              </div>
            </section>
          )}

          {job && (
            <dl className="cart-lib__wizard-status">
              <div>
                <dt>{text.importStatus}</dt>
                <dd>{jobStatusLabel(text, job.status)}</dd>
              </div>
              <div>
                <dt>{text.importPhase}</dt>
                <dd>{job.phase}</dd>
              </div>
              {validation && (
                <div>
                  <dt>{text.importValidation}</dt>
                  <dd>
                    {errors} / {warnings}
                  </dd>
                </div>
              )}
              {diff && (
                <div>
                  <dt>{text.importDiffHeading}</dt>
                  <dd>
                    {diff.new} {text.importDiffNew} · {diff.changed} {text.importDiffChanged} ·{' '}
                    {diff.unchanged} {text.importDiffUnchanged} ·{' '}
                    {diff.deprecated} {text.importDiffDeprecated}
                    {appliedView?.result?.applyResult?.diff?.blocked
                      ? ` · ${appliedView.result.applyResult.diff.blocked} ${text.importDiffBlocked}`
                      : ''}
                  </dd>
                </div>
              )}
              {job.error && (
                <div className="cart-lib__wizard-error">
                  <dt>{text.importFailed}</dt>
                  <dd>
                    {job.error.code}: {job.error.message}
                  </dd>
                </div>
              )}
            </dl>
          )}

          {appliedView && (
            <p className="cart-lib__wizard-applied">{text.importApplied}</p>
          )}

          {warnings > 0 && job?.status === 'ready' && !appliedView && (
            <label className="cart-lib__field cart-lib__field--checkbox">
              <input
                type="checkbox"
                checked={acceptWarnings}
                onChange={(e) => setAcceptWarnings(e.target.checked)}
              />
              <span>{text.importAcceptWarnings}</span>
            </label>
          )}

          {errorMessage && (
            <p className="cart-lib__wizard-error" role="alert">
              {errorMessage}
            </p>
          )}
        </div>

        <footer className="cart-lib__wizard-foot">
          <button
            type="button"
            className="cart-lib__btn cart-lib__btn--ghost"
            onClick={onClose}
          >
            {text.importClose}
          </button>
          {(job?.status === 'queued' || job?.status === 'running') && (
            <button
              type="button"
              className="cart-lib__btn"
              onClick={onCancel}
            >
              {text.importCancel}
            </button>
          )}
          {!job || job.status === 'failed' || job.status === 'cancelled' ? (
            <button
              type="button"
              className="cart-lib__btn cart-lib__btn--primary"
              onClick={onCreate}
              disabled={busy || sourcePath.trim().length === 0}
            >
              {text.importCreate}
            </button>
          ) : (
            <button
              type="button"
              className="cart-lib__btn cart-lib__btn--primary"
              onClick={onApply}
              disabled={!canApply || busy}
            >
              {text.importApply}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
