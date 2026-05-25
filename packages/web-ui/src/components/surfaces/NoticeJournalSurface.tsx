/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-NOTICE-1 — Notice Journal surface body.
//
// Server-state-as-canon: all data flows through
// `useNoticeJournal` (which consumes `bridge/noticeJournal.ts`),
// so this component never calls `fetch` directly. The previous
// FEAT-SHELL placeholder rendered live in-memory `systemEvents`
// via `EventCard`; this body reads the durable
// `player_journal_entries` projection through the bridge instead,
// keeps the timeline across reloads, and adds server-owned filter
// chips + cursor-based "load older" pagination.

import {useMemo, useState} from 'react';
import {AlertOctagon, Loader2, NotebookText, RefreshCcw} from 'lucide-react';
import {
  useNoticeJournal,
  type UseNoticeJournalResult,
} from '../../hooks/useNoticeJournal';
import type {
  JournalEntryType,
  NoticeJournalEntry,
} from '../../bridge/noticeJournal';

type TranslationFn = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

interface Props {
  playerId: number;
  language?: string | null;
  t: TranslationFn;
}

type FilterChoice = 'all' | JournalEntryType;

const FILTER_ORDER: ReadonlyArray<FilterChoice> = [
  'all',
  'quest',
  'progression',
  'relationship',
  'story',
  'world',
  'system',
];

export function NoticeJournalSurface({playerId, language, t}: Props) {
  const safePlayerId = playerId && playerId > 0 ? playerId : 0;
  const [filter, setFilter] = useState<FilterChoice>('all');
  const serverType: JournalEntryType | null = filter === 'all' ? null : filter;
  const hook: UseNoticeJournalResult = useNoticeJournal({
    playerId: safePlayerId,
    language: language ?? null,
    type: serverType,
  });
  const {entries, status, hasMore, loadingMore, refresh, loadMore} = hook;

  if (!safePlayerId) {
    return (
      <div className="player-surface-section notice-journal-empty">
        <p className="modal-placeholder">
          <NotebookText size={14} /> {t('ui.surface.journal.empty')}
        </p>
      </div>
    );
  }

  if (status === 'loading' && entries.length === 0) {
    return (
      <div className="player-surface-section notice-journal-loading">
        <p className="modal-placeholder">
          <Loader2 size={14} className="spin" />{' '}
          {t('ui.surface.journal.loading')}
        </p>
      </div>
    );
  }

  if (status === 'error' && entries.length === 0) {
    return (
      <div className="player-surface-section notice-journal-error">
        <p className="modal-placeholder">
          <AlertOctagon size={14} /> {t('ui.surface.journal.error')}
        </p>
        <button
          type="button"
          className="notice-journal-retry"
          onClick={() => void refresh()}
        >
          <RefreshCcw size={14} /> {t('ui.surface.journal.retry')}
        </button>
      </div>
    );
  }

  return (
    <div className="player-surface-section notice-journal">
      <NoticeJournalFilters filter={filter} onFilter={setFilter} t={t} />
      {entries.length === 0 ? (
        <p className="modal-placeholder notice-journal-empty">
          {t(`ui.surface.journal.bucket.${filter}.empty`)}
        </p>
      ) : (
        <ul className="notice-journal-list">
          {entries.map((entry) => (
            <NoticeJournalRow key={entry.id} entry={entry} t={t} />
          ))}
        </ul>
      )}
      {hasMore && (
        <div className="notice-journal-load-more-row">
          <button
            type="button"
            className="notice-journal-load-more"
            onClick={() => void loadMore()}
            disabled={loadingMore}
          >
            {loadingMore ? (
              <>
                <Loader2 size={14} className="spin" />{' '}
                {t('ui.surface.journal.loading_more')}
              </>
            ) : (
              t('ui.surface.journal.load_more')
            )}
          </button>
        </div>
      )}
      {status === 'error' && entries.length > 0 && (
        <p className="notice-journal-stale-warning">
          <AlertOctagon size={12} /> {t('ui.surface.journal.stale')}
        </p>
      )}
    </div>
  );
}

interface FilterProps {
  filter: FilterChoice;
  onFilter: (next: FilterChoice) => void;
  t: TranslationFn;
}

function NoticeJournalFilters({filter, onFilter, t}: FilterProps) {
  return (
    <div className="notice-journal-filters" role="tablist">
      {FILTER_ORDER.map((id) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={filter === id}
          className={`notice-journal-filter${filter === id ? ' active' : ''}`}
          onClick={() => onFilter(id)}
        >
          {t(`ui.surface.journal.filter.${id}`)}
        </button>
      ))}
    </div>
  );
}

interface RowProps {
  entry: NoticeJournalEntry;
  t: TranslationFn;
}

function NoticeJournalRow({entry, t}: RowProps) {
  const dateLabel = useMemo(() => formatDate(entry.occurredAt), [entry.occurredAt]);
  return (
    <li className={`notice-journal-row notice-journal-row-${entry.entryType}`}>
      <div className="notice-journal-row-head">
        <span className={`notice-journal-pill notice-journal-pill-${entry.entryType}`}>
          {t(`ui.surface.journal.type.${entry.entryType}`)}
        </span>
        <time className="notice-journal-time" dateTime={entry.occurredAt}>
          {dateLabel}
        </time>
      </div>
      <p className="notice-journal-title">{entry.title}</p>
      {entry.body ? <p className="notice-journal-body">{entry.body}</p> : null}
    </li>
  );
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}
