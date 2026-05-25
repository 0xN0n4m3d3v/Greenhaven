/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-QUEST-1 — Quest Dashboard surface body.
//
// Server-state-as-canon: all data flows through
// `useQuestDashboard` (which consumes `bridge/questDashboard.ts`),
// so this component never calls `fetch` directly. Renders status
// tabs, search, a quest list + detail layout, the active
// objective tracker, stage timeline, rewards, and a `recentEvents`
// history rail. This surface is now the single quest UI.

import {useMemo, useState} from 'react';
import {
  AlertOctagon,
  CheckCircle2,
  Circle,
  Loader2,
  Search,
  ScrollText,
} from 'lucide-react';
import {useQuestDashboard} from '../../hooks/useQuestDashboard';
import type {
  QuestDashboardCard,
  QuestDashboardEvent,
  QuestDashboardSnapshot,
  QuestStatus,
} from '../../bridge/questDashboard';

type TranslationFn = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

interface Props {
  playerId: number;
  language?: string | null;
  t: TranslationFn;
}

type TabId =
  | 'active'
  | 'choiceRequired'
  | 'offered'
  | 'completed'
  | 'failed'
  | 'archived';

const TAB_ORDER: ReadonlyArray<TabId> = [
  'active',
  'choiceRequired',
  'offered',
  'completed',
  'failed',
  'archived',
];

export function QuestDashboardSurface({playerId, language, t}: Props) {
  const safePlayerId = playerId && playerId > 0 ? playerId : 0;
  const {snapshot, status} = useQuestDashboard({
    playerId: safePlayerId,
    language: language ?? null,
  });
  const [tab, setTab] = useState<TabId>('active');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const visibleCards = useMemo(
    () => filterAndSearch(pickCards(snapshot, tab), search),
    [snapshot, tab, search],
  );

  const selectedCard = useMemo(() => {
    if (!snapshot) return null;
    if (selectedId == null) return visibleCards[0] ?? null;
    const all = [
      ...snapshot.active,
      ...snapshot.offered,
      ...snapshot.completed,
      ...snapshot.failed,
      ...snapshot.archived,
    ];
    return (
      all.find((c) => c.id === selectedId) ?? visibleCards[0] ?? null
    );
  }, [snapshot, selectedId, visibleCards]);

  if (!safePlayerId) {
    return (
      <div className="player-surface-section quest-dashboard-empty">
        <p className="modal-placeholder">
          <ScrollText size={14} /> {t('ui.surface.quests.empty')}
        </p>
      </div>
    );
  }

  if (status === 'loading' && !snapshot) {
    return (
      <div className="player-surface-section quest-dashboard-loading">
        <p className="modal-placeholder">
          <Loader2 size={14} className="spin" />{' '}
          {t('ui.surface.quests.loading')}
        </p>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="player-surface-section quest-dashboard-error">
        <p className="modal-placeholder">
          <AlertOctagon size={14} /> {t('ui.surface.quests.error')}
        </p>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="player-surface-section quest-dashboard-empty">
        <p className="modal-placeholder">
          <ScrollText size={14} /> {t('ui.surface.quests.empty')}
        </p>
      </div>
    );
  }

  return (
    <div className="player-surface-section quest-dashboard">
      <QuestSummaryRow snapshot={snapshot} t={t} />
      <StatusTabs
        snapshot={snapshot}
        tab={tab}
        onTab={(next) => {
          setTab(next);
          setSelectedId(null);
        }}
        t={t}
      />
      <div className="quest-dashboard-toolbar">
        <label className="quest-dashboard-search">
          <Search size={14} aria-hidden />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('ui.surface.quests.search.placeholder')}
            aria-label={t('ui.surface.quests.search.placeholder')}
          />
        </label>
      </div>
      <div className="quest-dashboard-body">
        <QuestList
          cards={visibleCards}
          selectedId={selectedCard?.id ?? null}
          onSelect={(id) => setSelectedId(id)}
          emptyKey={emptyKeyForTab(tab)}
          t={t}
        />
        {selectedCard ? (
          <QuestDetail card={selectedCard} t={t} />
        ) : (
          <aside className="quest-dashboard-detail quest-dashboard-detail-empty">
            <p className="modal-placeholder">
              {t('ui.surface.quests.detail.none_selected')}
            </p>
          </aside>
        )}
      </div>
      <RecentEvents events={snapshot.recentEvents} t={t} />
    </div>
  );
}

function pickCards(
  snapshot: QuestDashboardSnapshot | null,
  tab: TabId,
): QuestDashboardCard[] {
  if (!snapshot) return [];
  switch (tab) {
    case 'active':
      return snapshot.active;
    case 'choiceRequired':
      return snapshot.choiceRequired;
    case 'offered':
      return snapshot.offered;
    case 'completed':
      return snapshot.completed;
    case 'failed':
      return snapshot.failed;
    case 'archived':
      return snapshot.archived;
  }
}

function filterAndSearch(
  cards: QuestDashboardCard[],
  search: string,
): QuestDashboardCard[] {
  const needle = search.trim().toLocaleLowerCase();
  if (!needle) return cards;
  return cards.filter((c) => {
    const hay = `${c.name} ${c.summary ?? ''} ${c.partner ?? ''} ${c.giver ?? ''}`
      .toLocaleLowerCase();
    return hay.includes(needle);
  });
}

function emptyKeyForTab(tab: TabId): string {
  return `ui.surface.quests.bucket.${tab}.empty`;
}

interface SummaryProps {
  snapshot: QuestDashboardSnapshot;
  t: TranslationFn;
}

function QuestSummaryRow({snapshot, t}: SummaryProps) {
  const s = snapshot.summary;
  return (
    <dl className="quest-dashboard-summary">
      <div>
        <dt>{t('ui.surface.quests.summary.active')}</dt>
        <dd>{s.active}</dd>
      </div>
      <div>
        <dt>{t('ui.surface.quests.summary.choice_required')}</dt>
        <dd>{s.choiceRequired}</dd>
      </div>
      <div>
        <dt>{t('ui.surface.quests.summary.offered')}</dt>
        <dd>{s.offered}</dd>
      </div>
      <div>
        <dt>{t('ui.surface.quests.summary.completed')}</dt>
        <dd>{s.completed}</dd>
      </div>
      <div>
        <dt>{t('ui.surface.quests.summary.failed')}</dt>
        <dd>{s.failed}</dd>
      </div>
    </dl>
  );
}

interface TabsProps {
  snapshot: QuestDashboardSnapshot;
  tab: TabId;
  onTab: (next: TabId) => void;
  t: TranslationFn;
}

function StatusTabs({snapshot, tab, onTab, t}: TabsProps) {
  const counts: Record<TabId, number> = {
    active: snapshot.active.length,
    choiceRequired: snapshot.choiceRequired.length,
    offered: snapshot.offered.length,
    completed: snapshot.completed.length,
    failed: snapshot.failed.length,
    archived: snapshot.archived.length,
  };
  return (
    <div className="quest-dashboard-tabs" role="tablist">
      {TAB_ORDER.map((id) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={tab === id}
          className={`quest-dashboard-tab${tab === id ? ' active' : ''}`}
          onClick={() => onTab(id)}
        >
          <span>{t(`ui.surface.quests.tab.${id}`)}</span>
          <span className="quest-dashboard-tab-count">{counts[id]}</span>
        </button>
      ))}
    </div>
  );
}

interface ListProps {
  cards: QuestDashboardCard[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  emptyKey: string;
  t: TranslationFn;
}

function QuestList({cards, selectedId, onSelect, emptyKey, t}: ListProps) {
  if (cards.length === 0) {
    return (
      <ul className="quest-dashboard-list quest-dashboard-list-empty">
        <li>
          <p className="modal-placeholder">{t(emptyKey)}</p>
        </li>
      </ul>
    );
  }
  return (
    <ul className="quest-dashboard-list">
      {cards.map((c) => (
        <li key={c.id}>
          <button
            type="button"
            className={`quest-dashboard-list-row${
              selectedId === c.id ? ' selected' : ''
            }${c.awaitingChoice ? ' awaiting-choice' : ''}`}
            onClick={() => onSelect(c.id)}
          >
            <span className="quest-dashboard-list-name">{c.name}</span>
            <span className="quest-dashboard-list-meta">
              {c.stage && (
                <span className="quest-dashboard-list-stage">
                  {c.stage.name}
                </span>
              )}
              {c.awaitingChoice && (
                <span className="quest-dashboard-list-badge">
                  {t('ui.surface.quests.badge.choice_required')}
                </span>
              )}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

interface DetailProps {
  card: QuestDashboardCard;
  t: TranslationFn;
}

function QuestDetail({card, t}: DetailProps) {
  return (
    <aside className="quest-dashboard-detail">
      <header>
        <h3>{card.name}</h3>
        <p className="quest-dashboard-detail-meta">
          {t(`ui.surface.quests.status.${card.status}`)}
          {card.partner && <> · {card.partner}</>}
          {card.location && <> · {card.location}</>}
        </p>
      </header>
      {card.summary && (
        <p className="quest-dashboard-detail-summary">{card.summary}</p>
      )}
      {card.awaitingChoice && (
        <p
          className="quest-dashboard-detail-callout"
          role="status"
        >
          {t('ui.surface.quests.detail.awaiting_choice')}
        </p>
      )}
      {card.stage && (
        <section className="quest-dashboard-detail-stage">
          <h4>{t('ui.surface.quests.detail.current_stage')}</h4>
          <p className="quest-dashboard-detail-stage-name">{card.stage.name}</p>
          {card.stage.description && (
            <p className="quest-dashboard-detail-stage-desc">
              {card.stage.description}
            </p>
          )}
        </section>
      )}
      {card.objectives.length > 0 && (
        <section className="quest-dashboard-detail-objectives">
          <h4>{t('ui.surface.quests.detail.objectives')}</h4>
          <ul>
            {card.objectives.map((o, i) => (
              <li
                key={i}
                className={
                  o.satisfied
                    ? 'quest-dashboard-objective done'
                    : 'quest-dashboard-objective pending'
                }
              >
                {o.satisfied ? (
                  <CheckCircle2 size={14} aria-hidden />
                ) : (
                  <Circle size={14} aria-hidden />
                )}
                <span>{o.text}</span>
                {o.detail && (
                  <small className="quest-dashboard-objective-detail">
                    {o.detail}
                  </small>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {card.stages.length > 0 && (
        <section className="quest-dashboard-detail-timeline">
          <h4>{t('ui.surface.quests.detail.timeline')}</h4>
          <ol>
            {card.stages.map((s) => (
              <li
                key={s.id}
                className={`quest-dashboard-timeline-step status-${s.status}`}
              >
                <span className="quest-dashboard-timeline-name">{s.name}</span>
                {s.description && (
                  <small className="quest-dashboard-timeline-desc">
                    {s.description}
                  </small>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}
      {card.rewards && (
        <section className="quest-dashboard-detail-rewards">
          <h4>{t('ui.surface.quests.detail.rewards')}</h4>
          <ul>
            {typeof card.rewards.xp === 'number' && (
              <li>
                {t('ui.surface.quests.detail.reward_xp', {xp: card.rewards.xp})}
              </li>
            )}
            {Array.isArray(card.rewards.strings) &&
              card.rewards.strings.map((s, i) => (
                <li key={`string-${i}`}>
                  {t('ui.surface.quests.detail.reward_string', {
                    npc: s.npc,
                    delta: s.delta,
                  })}
                </li>
              ))}
            {Array.isArray(card.rewards.items) &&
              card.rewards.items.map((it, i) => (
                <li key={`item-${i}`}>
                  {it.name}
                  {it.quantity ? ` ×${it.quantity}` : ''}
                </li>
              ))}
          </ul>
        </section>
      )}
      {card.nextActionHint && card.status === 'active' && (
        <p className="quest-dashboard-detail-hint">
          <strong>{t('ui.surface.quests.detail.next_action')}</strong>{' '}
          {card.nextActionHint}
        </p>
      )}
      <dl className="quest-dashboard-detail-times">
        {card.startedAt && (
          <div>
            <dt>{t('ui.surface.quests.detail.started_at')}</dt>
            <dd>{card.startedAt}</dd>
          </div>
        )}
        {card.completedAt && (
          <div>
            <dt>{t('ui.surface.quests.detail.completed_at')}</dt>
            <dd>{card.completedAt}</dd>
          </div>
        )}
      </dl>
    </aside>
  );
}

interface RecentEventsProps {
  events: QuestDashboardEvent[];
  t: TranslationFn;
}

function RecentEvents({events, t}: RecentEventsProps) {
  if (events.length === 0) return null;
  return (
    <section className="quest-dashboard-history">
      <h4>{t('ui.surface.quests.history.heading')}</h4>
      <ul>
        {events.slice(0, 12).map((ev) => (
          <li key={ev.id}>
            <span className="quest-dashboard-history-type">
              {t(`ui.surface.quests.history.type.${ev.type}` as never) ||
                ev.type}
            </span>
            {ev.questName && (
              <span className="quest-dashboard-history-name">
                {ev.questName}
              </span>
            )}
            {ev.releasedAt && (
              <span className="quest-dashboard-history-time">
                {ev.releasedAt}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// Compile-time guard: keeps the QuestStatus type referenced so a
// future status change forces an update here.
const _exhaustive: QuestStatus[] = [
  'active',
  'completed',
  'failed',
  'offered',
  'archived',
  'unseen',
];
void _exhaustive;
