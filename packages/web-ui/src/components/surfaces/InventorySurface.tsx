/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-INV-1 — Inventory surface body.
//
// Server-state-as-canon: all data flows through
// `useInventorySnapshot` (which consumes `bridge/inventory.ts`),
// so this component never calls `fetch` directly. The detail
// panel's action buttons dispatch through `postInventoryAction`,
// which delegates to the existing `use_item` / `equip_item` /
// `give_to_npc` tools on the server. The snapshot refresh is
// driven by the `inventory:changed` SSE channel, so we never
// mutate local state optimistically.
//
// Accepts `playerId` from `GameScreen`; falls back to a friendly
// empty state when the player hasn't bootstrapped yet (e.g. the
// surface opened during the brand-new-game first-launch race).

import {useCallback, useMemo, useState} from 'react';
import {
  AlertOctagon,
  Backpack,
  Coins,
  LayoutGrid,
  List,
  Loader2,
  Search,
} from 'lucide-react';
import {
  useInventorySnapshot,
  type UseInventorySnapshotResult,
} from '../../hooks/useInventorySnapshot';
import {MediaAsset} from '../media/MediaAsset';
import {
  postInventoryAction,
  type InventoryActionKind,
  type InventoryActionResult,
  type InventoryCategory,
  type InventoryItem,
  type InventorySnapshot,
} from '../../bridge/inventory';
import {readStoredSessionId} from '../../lib/clientStorage';

type TranslationFn = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

interface Props {
  t: TranslationFn;
  playerId?: number;
  language?: string | null;
}

const CATEGORY_ORDER: ReadonlyArray<'all' | InventoryCategory> = [
  'all',
  'weapon',
  'armor',
  'consumable',
  'tool',
  'quest',
  'material',
  'misc',
];

type ViewMode = 'list' | 'grid';

interface ActionState {
  pending: InventoryActionKind | null;
  error: string | null;
  successAction: InventoryActionKind | null;
}

const INITIAL_ACTION_STATE: ActionState = {
  pending: null,
  error: null,
  successAction: null,
};

export function InventorySurface({t, playerId, language}: Props) {
  const safePlayerId = playerId && playerId > 0 ? playerId : 0;
  const hookResult: UseInventorySnapshotResult = useInventorySnapshot({
    playerId: safePlayerId,
    language: language ?? null,
  });
  const {snapshot, status} = hookResult;
  const [filter, setFilter] = useState<'all' | InventoryCategory>('all');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [actionState, setActionState] = useState<ActionState>(
    INITIAL_ACTION_STATE,
  );

  const visibleItems = useMemo(
    () => filterAndSearch(snapshot?.items ?? [], filter, search),
    [snapshot, filter, search],
  );

  const selected = useMemo(() => {
    if (!selectedId) return null;
    return (
      snapshot?.items.find((item) => item.id === selectedId) ?? null
    );
  }, [snapshot, selectedId]);

  const runAction = useCallback(
    async (
      action: InventoryActionKind,
      item: InventoryItem,
      extras?: {npc?: string; quantity?: number},
    ): Promise<InventoryActionResult> => {
      if (!safePlayerId || !item.slug) {
        const failure: InventoryActionResult = {
          ok: false,
          action,
          error: 'inventory_action_unavailable',
        };
        setActionState({
          pending: null,
          error: failure.error ?? null,
          successAction: null,
        });
        return failure;
      }
      const sessionId = readStoredSessionId();
      if (!sessionId) {
        const failure: InventoryActionResult = {
          ok: false,
          action,
          error: 'inventory_action_no_session',
        };
        setActionState({
          pending: null,
          error: failure.error ?? null,
          successAction: null,
        });
        return failure;
      }
      setActionState({pending: action, error: null, successAction: null});
      const result = await postInventoryAction({
        playerId: safePlayerId,
        sessionId,
        action,
        itemSlug: item.slug,
        ...(extras?.npc ? {npc: extras.npc} : {}),
        ...(extras?.quantity != null ? {quantity: extras.quantity} : {}),
      });
      setActionState({
        pending: null,
        error: result.ok ? null : result.error ?? 'inventory_action_failed',
        successAction: result.ok ? action : null,
      });
      // Snapshot refresh arrives through the `inventory:changed`
      // SSE channel `useInventorySnapshot` listens on, so we
      // intentionally do NOT mutate local state here.
      return result;
    },
    [safePlayerId],
  );

  if (!safePlayerId) {
    return (
      <div className="player-surface-section inventory-surface-empty">
        <p className="modal-placeholder">
          <Backpack size={14} /> {t('ui.surface.inventory.empty')}
        </p>
      </div>
    );
  }

  if (status === 'loading' && !snapshot) {
    return (
      <div className="player-surface-section inventory-surface-loading">
        <p className="modal-placeholder">
          <Loader2 size={14} className="spin" />{' '}
          {t('ui.surface.inventory.loading')}
        </p>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="player-surface-section inventory-surface-error">
        <p className="modal-placeholder">
          <AlertOctagon size={14} /> {t('ui.surface.inventory.error')}
        </p>
      </div>
    );
  }

  if (!snapshot) {
    // Defensive — `status === 'ready'` with no snapshot means
    // the player resolution above failed silently.
    return (
      <div className="player-surface-section inventory-surface-empty">
        <p className="modal-placeholder">
          <Backpack size={14} /> {t('ui.surface.inventory.empty')}
        </p>
      </div>
    );
  }

  return (
    <div className="player-surface-section inventory-surface">
      <InventorySummary snapshot={snapshot} t={t} />
      <EquipmentRow snapshot={snapshot} t={t} onSelect={setSelectedId} />
      <FilterChips filter={filter} onFilter={setFilter} t={t} />
      <div className="inventory-toolbar">
        <SearchInput value={search} onChange={setSearch} t={t} />
        <ViewModeToggle mode={viewMode} onChange={setViewMode} t={t} />
      </div>
      <BagList
        items={visibleItems}
        selectedId={selectedId}
        onSelect={setSelectedId}
        viewMode={viewMode}
        t={t}
      />
      {selected && (
        <ItemDetail
          item={selected}
          t={t}
          actionState={actionState}
          onAction={runAction}
        />
      )}
    </div>
  );
}

function filterAndSearch(
  items: InventoryItem[],
  filter: 'all' | InventoryCategory,
  search: string,
): InventoryItem[] {
  const needle = search.trim().toLocaleLowerCase();
  return items.filter((item) => {
    if (filter !== 'all' && item.category !== filter) return false;
    if (!needle) return true;
    const hay = `${item.name} ${item.slug ?? ''} ${item.summary ?? ''}`
      .toLocaleLowerCase();
    return hay.includes(needle);
  });
}

interface InventorySummaryProps {
  snapshot: InventorySnapshot;
  t: TranslationFn;
}

function InventorySummary({snapshot, t}: InventorySummaryProps) {
  return (
    <div className="inventory-summary">
      <div className="inventory-currency">
        <Coins size={14} />
        <span>{snapshot.currency.count}</span>
        <small>{t('ui.surface.inventory.currency_label')}</small>
      </div>
      <dl className="inventory-totals">
        <div>
          <dt>{t('ui.surface.inventory.totals.items')}</dt>
          <dd>{snapshot.totals.itemCount}</dd>
        </div>
        <div>
          <dt>{t('ui.surface.inventory.totals.unique')}</dt>
          <dd>{snapshot.totals.uniqueItems}</dd>
        </div>
        <div>
          <dt>{t('ui.surface.inventory.totals.weight')}</dt>
          <dd>
            {t('ui.surface.inventory.totals.weight_value', {
              kg: snapshot.totals.weightKg,
            })}
          </dd>
        </div>
        <div>
          <dt>{t('ui.surface.inventory.totals.equipped')}</dt>
          <dd>{snapshot.totals.equippedCount}</dd>
        </div>
      </dl>
    </div>
  );
}

interface EquipmentRowProps {
  snapshot: InventorySnapshot;
  t: TranslationFn;
  onSelect: (id: string) => void;
}

function EquipmentRow({snapshot, t, onSelect}: EquipmentRowProps) {
  if (snapshot.equipment.length === 0) {
    return (
      <section className="inventory-equipment">
        <h3>{t('ui.surface.inventory.equipment.heading')}</h3>
        <p className="modal-placeholder">
          {t('ui.surface.inventory.equipment.empty')}
        </p>
      </section>
    );
  }
  return (
    <section className="inventory-equipment">
      <h3>{t('ui.surface.inventory.equipment.heading')}</h3>
      <ul className="inventory-equipment-list">
        {snapshot.equipment.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className="inventory-equipment-slot"
              onClick={() => onSelect(item.id)}
            >
              <span className="inventory-equipment-slot-label">
                {item.equippedSlot ??
                  t('ui.surface.inventory.equipment.slot_generic')}
              </span>
              <span className="inventory-equipment-item-name">
                {item.name}
              </span>
              {item.quantity > 1 && (
                <span className="inventory-equipment-qty">
                  ×{item.quantity}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

interface FilterChipsProps {
  filter: 'all' | InventoryCategory;
  onFilter: (next: 'all' | InventoryCategory) => void;
  t: TranslationFn;
}

function FilterChips({filter, onFilter, t}: FilterChipsProps) {
  return (
    <div className="inventory-filters" role="tablist">
      {CATEGORY_ORDER.map((cat) => (
        <button
          key={cat}
          type="button"
          role="tab"
          aria-selected={filter === cat}
          className={`inventory-filter-chip${
            filter === cat ? ' active' : ''
          }`}
          onClick={() => onFilter(cat)}
        >
          {t(`ui.surface.inventory.filter.${cat}`)}
        </button>
      ))}
    </div>
  );
}

interface SearchInputProps {
  value: string;
  onChange: (next: string) => void;
  t: TranslationFn;
}

function SearchInput({value, onChange, t}: SearchInputProps) {
  return (
    <label className="inventory-search">
      <Search size={14} aria-hidden />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t('ui.surface.inventory.search.placeholder')}
        aria-label={t('ui.surface.inventory.search.placeholder')}
      />
    </label>
  );
}

interface ViewModeToggleProps {
  mode: ViewMode;
  onChange: (next: ViewMode) => void;
  t: TranslationFn;
}

function ViewModeToggle({mode, onChange, t}: ViewModeToggleProps) {
  return (
    <div
      className="inventory-view-toggle"
      role="radiogroup"
      aria-label={t('ui.surface.inventory.view.label')}
    >
      <button
        type="button"
        role="radio"
        aria-checked={mode === 'list'}
        className={`inventory-view-toggle-btn${
          mode === 'list' ? ' active' : ''
        }`}
        onClick={() => onChange('list')}
        title={t('ui.surface.inventory.view.list')}
      >
        <List size={14} aria-hidden />
        <span className="sr-only">{t('ui.surface.inventory.view.list')}</span>
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={mode === 'grid'}
        className={`inventory-view-toggle-btn${
          mode === 'grid' ? ' active' : ''
        }`}
        onClick={() => onChange('grid')}
        title={t('ui.surface.inventory.view.grid')}
      >
        <LayoutGrid size={14} aria-hidden />
        <span className="sr-only">{t('ui.surface.inventory.view.grid')}</span>
      </button>
    </div>
  );
}

interface BagListProps {
  items: InventoryItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  viewMode: ViewMode;
  t: TranslationFn;
}

function BagList({items, selectedId, onSelect, viewMode, t}: BagListProps) {
  if (items.length === 0) {
    return (
      <p className="modal-placeholder">
        {t('ui.surface.inventory.bag.empty')}
      </p>
    );
  }
  return (
    <ul className={`inventory-bag-list inventory-bag-list-${viewMode}`}>
      {items.map((item) => (
        <li key={item.id}>
          <button
            type="button"
            className={`inventory-bag-row${
              selectedId === item.id ? ' selected' : ''
            }${item.equipped ? ' equipped' : ''}`}
            onClick={() => onSelect(item.id)}
          >
            {item.iconUrl ? (
              <MediaAsset className="inventory-bag-icon" src={item.iconUrl} alt="" />
            ) : null}
            <span className="inventory-bag-name">{item.name}</span>
            <span className="inventory-bag-meta">
              <span className="inventory-bag-category">
                {t(`ui.surface.inventory.filter.${item.category}`)}
              </span>
              {item.quantity > 1 && (
                <span className="inventory-bag-qty">×{item.quantity}</span>
              )}
              {item.equipped && (
                <span className="inventory-bag-equipped-badge">
                  {t('ui.surface.inventory.equipment.equipped_badge')}
                </span>
              )}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

interface ItemDetailProps {
  item: InventoryItem;
  t: TranslationFn;
  actionState: ActionState;
  onAction: (
    action: InventoryActionKind,
    item: InventoryItem,
    extras?: {npc?: string; quantity?: number},
  ) => Promise<InventoryActionResult>;
}

function ItemDetail({item, t, actionState, onAction}: ItemDetailProps) {
  const attributeEntries = Object.entries(item.attributes).filter(
    ([, value]) => value !== null && value !== undefined,
  );
  return (
    <aside className="inventory-detail">
      <header>
        {item.iconUrl ? (
          <MediaAsset className="inventory-detail-art" src={item.iconUrl} alt="" />
        ) : null}
        <h3>{item.name}</h3>
        <p className="inventory-detail-meta">
          {t(`ui.surface.inventory.filter.${item.category}`)}
          {item.rarity && (
            <>
              {' · '}
              <span className={`inventory-rarity rarity-${item.rarity}`}>
                {item.rarity}
              </span>
            </>
          )}
          {item.quantity > 1 && <> · ×{item.quantity}</>}
        </p>
      </header>
      {item.summary && (
        <p className="inventory-detail-summary">{item.summary}</p>
      )}
      {item.equipped && (
        <p className="inventory-detail-equipped">
          {t('ui.surface.inventory.equipment.equipped_badge')}
          {item.equippedSlot && <> · {item.equippedSlot}</>}
        </p>
      )}
      {item.weightKg > 0 && (
        <p className="inventory-detail-weight">
          {t('ui.surface.inventory.detail.weight', {kg: item.weightKg})}
        </p>
      )}
      {attributeEntries.length > 0 && (
        <dl className="inventory-detail-attributes">
          {attributeEntries.map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>
                {typeof value === 'object'
                  ? JSON.stringify(value)
                  : String(value)}
              </dd>
            </div>
          ))}
        </dl>
      )}
      <ItemActions
        item={item}
        t={t}
        actionState={actionState}
        onAction={onAction}
      />
    </aside>
  );
}

interface ItemActionsProps {
  item: InventoryItem;
  t: TranslationFn;
  actionState: ActionState;
  onAction: ItemDetailProps['onAction'];
}

function ItemActions({item, t, actionState, onAction}: ItemActionsProps) {
  const canUse =
    item.source === 'player_inventory' &&
    (item.category === 'consumable' || item.category === 'tool');
  const canEquip =
    item.source === 'player_inventory' &&
    (item.category === 'weapon' || item.category === 'armor');
  const canGive =
    item.source === 'player_inventory' && item.category !== 'currency';

  if (!canUse && !canEquip && !canGive) {
    return (
      <p className="modal-placeholder inventory-detail-actions-empty">
        {t('ui.surface.inventory.detail.no_actions')}
      </p>
    );
  }

  const pending = actionState.pending;
  const anyPending = pending != null;

  return (
    <div className="inventory-detail-actions" role="group">
      {canUse && (
        <ActionButton
          kind="use"
          item={item}
          t={t}
          pending={pending === 'use'}
          disabled={anyPending}
          label={t('ui.surface.inventory.actions.use')}
          onAction={onAction}
        />
      )}
      {canEquip && !item.equipped && (
        <ActionButton
          kind="equip"
          item={item}
          t={t}
          pending={pending === 'equip'}
          disabled={anyPending}
          label={t('ui.surface.inventory.actions.equip')}
          onAction={onAction}
        />
      )}
      {canEquip && item.equipped && (
        <ActionButton
          kind="unequip"
          item={item}
          t={t}
          pending={pending === 'unequip'}
          disabled={anyPending}
          label={t('ui.surface.inventory.actions.unequip')}
          onAction={onAction}
        />
      )}
      {canGive && (
        <GiveAction
          item={item}
          t={t}
          pending={pending === 'give'}
          disabled={anyPending}
          onAction={onAction}
        />
      )}
      {actionState.error && (
        <p className="inventory-detail-action-error" role="alert">
          {t('ui.surface.inventory.actions.error.generic')}
        </p>
      )}
      {actionState.successAction && !actionState.error && (
        <p className="inventory-detail-action-success" role="status">
          {t(
            `ui.surface.inventory.actions.success.${actionState.successAction}`,
          )}
        </p>
      )}
    </div>
  );
}

interface ActionButtonProps {
  kind: InventoryActionKind;
  item: InventoryItem;
  t: TranslationFn;
  pending: boolean;
  disabled: boolean;
  label: string;
  onAction: ItemDetailProps['onAction'];
}

function ActionButton({
  kind,
  item,
  pending,
  disabled,
  label,
  onAction,
}: ActionButtonProps) {
  return (
    <button
      type="button"
      className={`inventory-detail-action-btn action-${kind}${
        pending ? ' pending' : ''
      }`}
      disabled={disabled}
      onClick={() => {
        void onAction(kind, item);
      }}
    >
      {pending && <Loader2 size={12} className="spin" />}
      <span>{label}</span>
    </button>
  );
}

interface GiveActionProps {
  item: InventoryItem;
  t: TranslationFn;
  pending: boolean;
  disabled: boolean;
  onAction: ItemDetailProps['onAction'];
}

function GiveAction({item, t, pending, disabled, onAction}: GiveActionProps) {
  const [npc, setNpc] = useState('');
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button
        type="button"
        className="inventory-detail-action-btn action-give"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <span>{t('ui.surface.inventory.actions.give')}</span>
      </button>
    );
  }
  return (
    <form
      className="inventory-detail-give-form"
      onSubmit={(e) => {
        e.preventDefault();
        const target = npc.trim();
        if (!target) return;
        void onAction('give', item, {npc: target, quantity: 1}).then(
          (result) => {
            if (result.ok) {
              setNpc('');
              setOpen(false);
            }
          },
        );
      }}
    >
      <label className="inventory-detail-give-label">
        <span>{t('ui.surface.inventory.actions.give_target_label')}</span>
        <input
          type="text"
          value={npc}
          onChange={(e) => setNpc(e.target.value)}
          placeholder={t(
            'ui.surface.inventory.actions.give_target_placeholder',
          )}
          autoFocus
        />
      </label>
      <div className="inventory-detail-give-controls">
        <button
          type="button"
          className="inventory-detail-action-btn action-cancel"
          onClick={() => {
            setOpen(false);
            setNpc('');
          }}
          disabled={pending}
        >
          {t('ui.surface.inventory.actions.cancel')}
        </button>
        <button
          type="submit"
          className={`inventory-detail-action-btn action-give${
            pending ? ' pending' : ''
          }`}
          disabled={disabled || npc.trim().length === 0}
        >
          {pending && <Loader2 size={12} className="spin" />}
          <span>{t('ui.surface.inventory.actions.give_confirm')}</span>
        </button>
      </div>
    </form>
  );
}
