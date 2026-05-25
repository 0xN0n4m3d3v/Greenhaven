/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-STATE-1 — typed Character State surface body.
//
// Server-state-as-canon: all data flows through
// `useCharacterState` (which consumes `bridge/characterState.ts`),
// so this component never calls the network directly. Player
// mutations (`equip_title` / `unequip_title` / `spend_stat_point`
// / `spend_skill_point`) dispatch through
// `postCharacterStateAction`, which the server routes into the
// matching tools; the visible snapshot refreshes from
// `character:*` SSE events `useCharacterState` already listens
// on, so we never mutate local state optimistically.
//
// `award_progression_xp` and `award_title` are intentionally NOT
// surfaced — those are broker / GM concerns and live on the
// tool / live-ops paths.

import {useCallback, useMemo, useState} from 'react';
import {
  AlertOctagon,
  Heart,
  Loader2,
  ScrollText,
  Shield,
  Sparkles,
  Star,
  TrendingUp,
  User,
} from 'lucide-react';
import {useCharacterState} from '../../hooks/useCharacterState';
import {
  postCharacterStateAction,
  type CharacterStateActionKind,
  type CharacterStateActionResult,
  type CharacterStateRankedSkill,
  type CharacterStateRuntimeField,
  type CharacterStateSnapshot,
  type CharacterStateStat,
  type CharacterStateTitle,
  type CharacterStateWallet,
  type CharacterStateXpLogEntry,
} from '../../bridge/characterState';
import {readStoredSessionId} from '../../lib/clientStorage';

type TranslationFn = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

interface Props {
  playerId: number;
  language?: string | null;
  t: TranslationFn;
}

type TabId = 'overview' | 'attributes' | 'skills' | 'titles' | 'progression';

const TAB_ORDER: ReadonlyArray<TabId> = [
  'overview',
  'attributes',
  'skills',
  'titles',
  'progression',
];

interface ActionPending {
  kind: CharacterStateActionKind;
  /** Disambiguates per-row spinners — title key, stat key, or skill ref. */
  target: string;
}

interface ActionState {
  pending: ActionPending | null;
  error: string | null;
  successKind: CharacterStateActionKind | null;
}

const INITIAL_ACTION_STATE: ActionState = {
  pending: null,
  error: null,
  successKind: null,
};

interface ActionDispatcher {
  state: ActionState;
  run: (params: {
    kind: CharacterStateActionKind;
    target: string;
    titleKey?: string;
    statKey?: string;
    skill?: string;
  }) => Promise<CharacterStateActionResult>;
}

export function CharacterStateSurface({playerId, language, t}: Props) {
  const safePlayerId = playerId && playerId > 0 ? playerId : 0;
  const {snapshot, status} = useCharacterState({
    playerId: safePlayerId,
    language: language ?? null,
  });
  const [tab, setTab] = useState<TabId>('overview');
  const [actionState, setActionState] = useState<ActionState>(
    INITIAL_ACTION_STATE,
  );

  const runAction = useCallback<ActionDispatcher['run']>(
    async ({kind, target, titleKey, statKey, skill}) => {
      if (!safePlayerId) {
        const failure: CharacterStateActionResult = {
          ok: false,
          action: kind,
          error: 'character_state_action_unavailable',
        };
        setActionState({
          pending: null,
          error: failure.error ?? null,
          successKind: null,
        });
        return failure;
      }
      const sessionId = readStoredSessionId();
      if (!sessionId) {
        const failure: CharacterStateActionResult = {
          ok: false,
          action: kind,
          error: 'character_state_action_no_session',
        };
        setActionState({
          pending: null,
          error: failure.error ?? null,
          successKind: null,
        });
        return failure;
      }
      setActionState({
        pending: {kind, target},
        error: null,
        successKind: null,
      });
      const result = await postCharacterStateAction({
        playerId: safePlayerId,
        sessionId,
        action: kind,
        ...(titleKey ? {titleKey} : {}),
        ...(statKey ? {statKey} : {}),
        ...(skill ? {skill} : {}),
      });
      setActionState({
        pending: null,
        error: result.ok ? null : result.error ?? 'character_state_action_failed',
        successKind: result.ok ? kind : null,
      });
      // Snapshot refresh arrives through the `character:*` SSE
      // channels `useCharacterState` listens on, so we
      // intentionally do NOT mutate local state here.
      return result;
    },
    [safePlayerId],
  );

  const dispatcher: ActionDispatcher = useMemo(
    () => ({state: actionState, run: runAction}),
    [actionState, runAction],
  );

  if (!safePlayerId) {
    return (
      <div className="player-surface-section character-state-empty">
        <p className="modal-placeholder">
          <User size={14} /> {t('ui.surface.character.empty')}
        </p>
      </div>
    );
  }

  if (status === 'loading' && !snapshot) {
    return (
      <div className="player-surface-section character-state-loading">
        <p className="modal-placeholder">
          <Loader2 size={14} className="spin" />{' '}
          {t('ui.surface.character.loading')}
        </p>
      </div>
    );
  }

  if (status === 'error' && !snapshot) {
    return (
      <div className="player-surface-section character-state-error">
        <p className="modal-placeholder">
          <AlertOctagon size={14} /> {t('ui.surface.character.error')}
        </p>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="player-surface-section character-state-empty">
        <p className="modal-placeholder">
          <User size={14} /> {t('ui.surface.character.empty')}
        </p>
      </div>
    );
  }

  return (
    <div className="player-surface-section character-state">
      <CharacterStateHeader snapshot={snapshot} t={t} />
      <CharacterStateTabs tab={tab} onTab={setTab} t={t} />
      <div className="character-state-body">
        {tab === 'overview' && (
          <OverviewTab snapshot={snapshot} t={t} />
        )}
        {tab === 'attributes' && (
          <AttributesTab
            stats={snapshot.stats}
            wallet={snapshot.progression.wallet}
            t={t}
            dispatcher={dispatcher}
          />
        )}
        {tab === 'skills' && (
          <SkillsTab
            proficient={snapshot.proficientSkills}
            ranked={snapshot.rankedSkills}
            wallet={snapshot.progression.wallet}
            t={t}
            dispatcher={dispatcher}
          />
        )}
        {tab === 'titles' && (
          <TitlesTab
            titles={snapshot.titles}
            t={t}
            dispatcher={dispatcher}
          />
        )}
        {tab === 'progression' && (
          <ProgressionTab snapshot={snapshot} t={t} />
        )}
      </div>
      <ActionStatusChip state={actionState} t={t} />
    </div>
  );
}

interface HeaderProps {
  snapshot: CharacterStateSnapshot;
  t: TranslationFn;
}

function CharacterStateHeader({snapshot, t}: HeaderProps) {
  const {identity, vitals} = snapshot;
  const hpPct = vitals.hp.max > 0
    ? Math.max(0, Math.min(1, vitals.hp.current / vitals.hp.max))
    : 0;
  const xpPct = vitals.xp.progress;
  return (
    <header className="character-state-header">
      <div className="character-state-identity">
        <div className="character-state-avatar" aria-hidden>
          {identity.displayName.trim()[0]?.toUpperCase() ?? '?'}
        </div>
        <div className="character-state-identity-text">
          <h3 className="character-state-name">{identity.displayName}</h3>
          <p className="character-state-class">
            {identity.className ?? t('ui.surface.character.class_unknown')}
          </p>
        </div>
      </div>
      <dl className="character-state-vitals">
        <div className="character-state-vital">
          <dt>
            <Heart size={12} /> {t('ui.surface.character.hp')}
          </dt>
          <dd>
            <span className="character-state-vital-numbers">
              {vitals.hp.current}/{vitals.hp.max}
            </span>
            <span
              className="character-state-bar"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={vitals.hp.max}
              aria-valuenow={vitals.hp.current}
            >
              <span
                className="character-state-bar-fill character-state-bar-hp"
                style={{width: `${(hpPct * 100).toFixed(1)}%`}}
              />
            </span>
          </dd>
        </div>
        <div className="character-state-vital">
          <dt>
            <Star size={12} /> {t('ui.surface.character.level')} {vitals.xp.level}
          </dt>
          <dd>
            <span className="character-state-vital-numbers">
              {vitals.xp.nextLevelXp != null
                ? t('ui.surface.character.xp_progress', {
                    current: vitals.xp.total - vitals.xp.thisLevelFloor,
                    needed: vitals.xp.nextLevelXp - vitals.xp.thisLevelFloor,
                  })
                : t('ui.surface.character.xp_max')}
            </span>
            <span
              className="character-state-bar"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={1}
              aria-valuenow={xpPct}
            >
              <span
                className="character-state-bar-fill character-state-bar-xp"
                style={{width: `${(xpPct * 100).toFixed(1)}%`}}
              />
            </span>
          </dd>
        </div>
      </dl>
    </header>
  );
}

interface TabsProps {
  tab: TabId;
  onTab: (next: TabId) => void;
  t: TranslationFn;
}

function CharacterStateTabs({tab, onTab, t}: TabsProps) {
  return (
    <div className="character-state-tabs" role="tablist">
      {TAB_ORDER.map((id) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={tab === id}
          className={`character-state-tab${tab === id ? ' active' : ''}`}
          onClick={() => onTab(id)}
        >
          {t(`ui.surface.character.tab.${id}`)}
        </button>
      ))}
    </div>
  );
}

interface OverviewProps {
  snapshot: CharacterStateSnapshot;
  t: TranslationFn;
}

function OverviewTab({snapshot, t}: OverviewProps) {
  const {equipment, progression, conditions, trauma} = snapshot;
  return (
    <div className="character-state-overview">
      <section className="character-state-pane">
        <h4>
          <Shield size={13} /> {t('ui.surface.character.equipment.heading')}
        </h4>
        {equipment.items.length === 0 ? (
          <p className="modal-placeholder">
            {t('ui.surface.character.equipment.empty')}
          </p>
        ) : (
          <ul className="character-state-equipment-list">
            {equipment.items.map((item) => (
              <li key={item.id}>
                <span className="character-state-equipment-name">
                  {item.name}
                </span>
                <span className="character-state-equipment-slot">
                  {item.slot
                    ? t(`ui.surface.character.equipment.slot.${item.slot}`, {
                        slot: item.slot,
                      })
                    : t('ui.surface.character.equipment.slot.generic')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="character-state-pane">
        <h4>
          <Sparkles size={13} /> {t('ui.surface.character.wallet.heading')}
        </h4>
        <dl className="character-state-wallet">
          <div>
            <dt>{t('ui.surface.character.wallet.stat_points')}</dt>
            <dd>{progression.wallet.statPoints}</dd>
          </div>
          <div>
            <dt>{t('ui.surface.character.wallet.skill_points')}</dt>
            <dd>{progression.wallet.skillPoints}</dd>
          </div>
          <div>
            <dt>{t('ui.surface.character.wallet.title_slots')}</dt>
            <dd>{progression.wallet.titleSlots}</dd>
          </div>
        </dl>
      </section>
      <section className="character-state-pane">
        <h4>{t('ui.surface.character.conditions.heading')}</h4>
        <RuntimeList
          entries={conditions}
          emptyLabel={t('ui.surface.character.conditions.empty')}
        />
      </section>
      <section className="character-state-pane">
        <h4>{t('ui.surface.character.trauma.heading')}</h4>
        <RuntimeList
          entries={trauma}
          emptyLabel={t('ui.surface.character.trauma.empty')}
        />
      </section>
    </div>
  );
}

interface RuntimeListProps {
  entries: CharacterStateRuntimeField[];
  emptyLabel: string;
}

function RuntimeList({entries, emptyLabel}: RuntimeListProps) {
  if (entries.length === 0) {
    return <p className="modal-placeholder">{emptyLabel}</p>;
  }
  return (
    <ul className="character-state-tag-list">
      {entries.map((entry, idx) => (
        <li key={`${entry.key}-${idx}`} className="character-state-tag">
          {entry.key || '—'}
        </li>
      ))}
    </ul>
  );
}

interface AttributesProps {
  stats: CharacterStateStat[];
  wallet: CharacterStateWallet;
  t: TranslationFn;
  dispatcher: ActionDispatcher;
}

function AttributesTab({stats, wallet, t, dispatcher}: AttributesProps) {
  if (stats.length === 0) {
    return (
      <p className="modal-placeholder">
        {t('ui.surface.character.attributes.empty')}
      </p>
    );
  }
  const canSpend = wallet.statPoints > 0;
  const anyPending = dispatcher.state.pending != null;
  return (
    <>
      <p className="character-state-action-summary">
        {t('ui.surface.character.attributes.wallet_hint', {
          points: wallet.statPoints,
        })}
      </p>
      <ul className="character-state-attributes">
        {stats.map((stat) => {
          const pending =
            dispatcher.state.pending?.kind === 'spend_stat_point' &&
            dispatcher.state.pending.target === stat.key;
          return (
            <li key={stat.key} className="character-state-attribute">
              <span className="character-state-attribute-key">{stat.key}</span>
              <span className="character-state-attribute-current">
                {stat.current}
              </span>
              {stat.current !== stat.base ? (
                <span className="character-state-attribute-base">
                  {t('ui.surface.character.attributes.base', {value: stat.base})}
                </span>
              ) : null}
              <button
                type="button"
                className={`character-state-action-btn action-spend-stat${
                  pending ? ' pending' : ''
                }`}
                disabled={!canSpend || anyPending}
                onClick={() => {
                  void dispatcher.run({
                    kind: 'spend_stat_point',
                    target: stat.key,
                    statKey: stat.key,
                  });
                }}
              >
                {pending && <Loader2 size={12} className="spin" />}
                <span>{t('ui.surface.character.actions.spend_stat')}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

interface SkillsProps {
  proficient: Array<{skillName: string; proficiencyLevel: number}>;
  ranked: CharacterStateRankedSkill[];
  wallet: CharacterStateWallet;
  t: TranslationFn;
  dispatcher: ActionDispatcher;
}

function SkillsTab({
  proficient,
  ranked,
  wallet,
  t,
  dispatcher,
}: SkillsProps) {
  if (proficient.length === 0 && ranked.length === 0) {
    return (
      <p className="modal-placeholder">
        {t('ui.surface.character.skills.empty')}
      </p>
    );
  }
  const canSpend = wallet.skillPoints > 0;
  const anyPending = dispatcher.state.pending != null;
  return (
    <div className="character-state-skills">
      <p className="character-state-action-summary">
        {t('ui.surface.character.skills.wallet_hint', {
          points: wallet.skillPoints,
        })}
      </p>
      {proficient.length > 0 && (
        <section className="character-state-pane">
          <h4>{t('ui.surface.character.skills.proficient_heading')}</h4>
          <ul className="character-state-skill-list">
            {proficient.map((row) => (
              <li key={row.skillName} className="character-state-skill">
                <span className="character-state-skill-name">
                  {row.skillName}
                </span>
                <span className="character-state-skill-mod">
                  {row.proficiencyLevel >= 2
                    ? t('ui.surface.character.skills.expertise')
                    : t('ui.surface.character.skills.proficient')}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {ranked.length > 0 && (
        <section className="character-state-pane">
          <h4>{t('ui.surface.character.skills.ranked_heading')}</h4>
          <ul className="character-state-skill-list">
            {ranked.map((row) => {
              const ref = row.name;
              const pending =
                dispatcher.state.pending?.kind === 'spend_skill_point' &&
                dispatcher.state.pending.target === ref;
              return (
                <li key={row.skillEntityId} className="character-state-skill">
                  <span className="character-state-skill-name">{row.name}</span>
                  <span className="character-state-skill-rank">
                    {t('ui.surface.character.skills.rank', {rank: row.rank})}
                  </span>
                  <button
                    type="button"
                    className={`character-state-action-btn action-spend-skill${
                      pending ? ' pending' : ''
                    }`}
                    disabled={!canSpend || anyPending}
                    onClick={() => {
                      void dispatcher.run({
                        kind: 'spend_skill_point',
                        target: ref,
                        skill: ref,
                      });
                    }}
                  >
                    {pending && <Loader2 size={12} className="spin" />}
                    <span>{t('ui.surface.character.actions.spend_skill')}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

interface TitlesProps {
  titles: CharacterStateTitle[];
  t: TranslationFn;
  dispatcher: ActionDispatcher;
}

function TitlesTab({titles, t, dispatcher}: TitlesProps) {
  if (titles.length === 0) {
    return (
      <p className="modal-placeholder">
        {t('ui.surface.character.titles.empty')}
      </p>
    );
  }
  const anyPending = dispatcher.state.pending != null;
  return (
    <ul className="character-state-titles">
      {titles.map((title) => {
        const pending =
          (dispatcher.state.pending?.kind === 'equip_title' ||
            dispatcher.state.pending?.kind === 'unequip_title') &&
          dispatcher.state.pending.target === title.titleKey;
        const actionKind: CharacterStateActionKind = title.isEquipped
          ? 'unequip_title'
          : 'equip_title';
        const label = title.isEquipped
          ? t('ui.surface.character.actions.unequip_title')
          : t('ui.surface.character.actions.equip_title');
        return (
          <li
            key={title.id}
            className={`character-state-title${
              title.isEquipped ? ' active' : ''
            }`}
          >
            <div className="character-state-title-head">
              <span className="character-state-title-name">
                {title.displayName}
              </span>
              {title.isEquipped ? (
                <span className="character-state-title-badge">
                  {t('ui.surface.character.titles.equipped')}
                </span>
              ) : null}
            </div>
            {title.description ? (
              <p className="character-state-title-desc">{title.description}</p>
            ) : null}
            {title.source ? (
              <p className="character-state-title-source">
                {t('ui.surface.character.titles.source', {source: title.source})}
              </p>
            ) : null}
            <div className="character-state-title-actions">
              <button
                type="button"
                className={`character-state-action-btn action-${
                  title.isEquipped ? 'unequip-title' : 'equip-title'
                }${pending ? ' pending' : ''}`}
                disabled={anyPending}
                onClick={() => {
                  void dispatcher.run({
                    kind: actionKind,
                    target: title.titleKey,
                    titleKey: title.titleKey,
                  });
                }}
              >
                {pending && <Loader2 size={12} className="spin" />}
                <span>{label}</span>
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

interface ProgressionProps {
  snapshot: CharacterStateSnapshot;
  t: TranslationFn;
}

function ProgressionTab({snapshot, t}: ProgressionProps) {
  const tracks = snapshot.progression.tracks;
  const log = snapshot.recentXpLog;
  return (
    <div className="character-state-progression">
      <section className="character-state-pane">
        <h4>
          <TrendingUp size={13} /> {t('ui.surface.character.progression.tracks_heading')}
        </h4>
        {tracks.length === 0 ? (
          <p className="modal-placeholder">
            {t('ui.surface.character.progression.tracks_empty')}
          </p>
        ) : (
          <ul className="character-state-track-list">
            {tracks.map((track) => (
              <li key={track.trackKey} className="character-state-track">
                <div className="character-state-track-head">
                  <span className="character-state-track-name">
                    {track.displayName}
                  </span>
                  <span className="character-state-track-level">
                    {t('ui.surface.character.progression.track_level', {
                      level: track.level,
                      max: track.maxLevel,
                    })}
                  </span>
                </div>
                {track.description ? (
                  <p className="character-state-track-desc">{track.description}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="character-state-pane">
        <h4>
          <ScrollText size={13} /> {t('ui.surface.character.progression.log_heading')}
        </h4>
        <XpLogList log={log} t={t} />
      </section>
    </div>
  );
}

interface XpLogProps {
  log: CharacterStateXpLogEntry[];
  t: TranslationFn;
}

function XpLogList({log, t}: XpLogProps) {
  const dates = useMemo(
    () => log.map((row) => formatDate(row.awardedAt)),
    [log],
  );
  if (log.length === 0) {
    return (
      <p className="modal-placeholder">
        {t('ui.surface.character.progression.log_empty')}
      </p>
    );
  }
  return (
    <ul className="character-state-xp-log">
      {log.map((row, idx) => (
        <li key={row.id} className="character-state-xp-row">
          <span className="character-state-xp-amount">
            {row.amount >= 0
              ? t('ui.surface.character.progression.log_amount_positive', {
                  amount: row.amount,
                })
              : t('ui.surface.character.progression.log_amount_negative', {
                  amount: Math.abs(row.amount),
                })}
          </span>
          <span className="character-state-xp-reason">{row.reason}</span>
          <time
            className="character-state-xp-time"
            dateTime={row.awardedAt}
          >
            {dates[idx]}
          </time>
        </li>
      ))}
    </ul>
  );
}

interface ActionStatusChipProps {
  state: ActionState;
  t: TranslationFn;
}

function ActionStatusChip({state, t}: ActionStatusChipProps) {
  if (state.error) {
    return (
      <p className="character-state-action-error" role="alert">
        {t('ui.surface.character.actions.error.generic')}
      </p>
    );
  }
  if (state.successKind) {
    return (
      <p className="character-state-action-success" role="status">
        {t(`ui.surface.character.actions.success.${state.successKind}`)}
      </p>
    );
  }
  return null;
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
