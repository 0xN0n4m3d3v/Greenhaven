// Spec 36 §4 carried-over — save-slots panel.
//
// Lists 5 named slots + 1 quicksave. Save / Load / Delete buttons
// drive the REST endpoints from packages/web-server/src/routes/saves.ts.
// Quicksave-on-death is server-side (combatDeath.ts → quicksaveOnDeath);
// when the player dies, the server auto-creates `slot_name='quicksave'`
// and the panel surfaces it on next refresh.

import {useEffect, useState} from 'react';
import {
  createSaveSlot,
  deleteSaveSlot,
  listSaveSlots,
  restoreSaveSlot,
  type SaveSlotRow,
} from '../../bridge/saves';
import {WeightedChoice} from '../choice/WeightedChoice';
import {ScrollArea} from '../ui/scroll-area';
import {toast} from '../ui/use-toast';

type SlotRow = SaveSlotRow;

export interface SaveSlotsPanelProps {
  playerId: number;
  baseUrl?: string;
}

export function SaveSlotsPanel({playerId, baseUrl = ''}: SaveSlotsPanelProps) {
  const [slots, setSlots] = useState<SlotRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState('');

  const refresh = async () => {
    try {
      const fetched = await listSaveSlots({playerId, baseUrl});
      setSlots(fetched);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    void refresh();
  }, [playerId]);

  const onSave = async () => {
    const slotName = draft.trim();
    if (!slotName) return;
    setBusy(true);
    try {
      const d = await createSaveSlot({playerId, slotName, baseUrl});
      if (d.ok) {
        toast({title: 'Saved', description: slotName});
        setDraft('');
        await refresh();
      } else {
        toast({title: 'Save failed', description: d.error ?? '', variant: 'destructive'});
      }
    } finally {
      setBusy(false);
    }
  };

  const onRestore = async (slot: SlotRow) => {
    setBusy(true);
    try {
      const d = await restoreSaveSlot({playerId, slotId: slot.id, baseUrl});
      if (d.ok) toast({title: 'Restored', description: slot.slot_name});
      else toast({title: 'Restore failed', description: d.error ?? '', variant: 'destructive'});
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async (slot: SlotRow) => {
    setBusy(true);
    try {
      await deleteSaveSlot({playerId, slotId: slot.id, baseUrl});
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-row">
      <label>Save slots</label>
      <p className="settings-hint">
        Named slots + auto-quicksave. The quicksave fires on player
        death (server-side) so a risky encounter can be rewound.
      </p>
      <div className="save-slot-create">
        <input
          type="text"
          maxLength={40}
          placeholder="Slot name"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          disabled={busy}
        />
        <button type="button" disabled={busy || !draft.trim()} onClick={onSave}>
          Save
        </button>
      </div>
      <ScrollArea className="save-slot-scroll">
        <ul className="save-slot-list">
          {slots.length === 0 && <li className="settings-hint">No saves yet.</li>}
          {slots.map(s => (
            <li key={s.id} className="save-slot-row">
              <span className="save-slot-name">
                {s.is_auto ? '⚡ ' : ''}{s.slot_name}
                <small className="save-slot-meta">
                  {Math.round(s.size_bytes / 1024)} KB · {new Date(s.created_at).toLocaleString()}
                </small>
              </span>
              <button type="button" onClick={() => onRestore(s)} disabled={busy}>
                Load
              </button>
              <WeightedChoice
                weight="heavy"
                disabled={busy}
                onCommit={() => onDelete(s)}
                ariaLabel={`Delete save slot ${s.slot_name}`}
                className="save-slot-delete"
              >
                ×
              </WeightedChoice>
            </li>
          ))}
        </ul>
      </ScrollArea>
    </section>
  );
}
