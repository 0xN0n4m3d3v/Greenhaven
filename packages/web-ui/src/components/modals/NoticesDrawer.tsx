// Spec 139 v2 — Notices drawer.
//
// Renders the full live feed of system events (quest, memory, combat,
// adventure, world shifts) as a chronological scroll list inside a
// right-side slide-in. Same EventCard component used inline in chat,
// but here grouped as a dedicated channel view (TG-style "system bot").

import {X} from 'lucide-react';
import {EventCard, type SystemEvent} from '../chat/EventCard';
import {compareSystemEvents} from '../chat/eventOrdering';

export interface NoticesDrawerProps {
  open: boolean;
  events: SystemEvent[];
  onClose: () => void;
  t: (key: string) => string;
}

export function NoticesDrawer({open, events, onClose, t}: NoticesDrawerProps) {
  if (!open) return null;
  const tx = (k: string, fb: string) => (t(k) === k ? fb : t(k));
  const sorted = [...events].sort(compareSystemEvents);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal notices-drawer"
        role="dialog"
        aria-modal
        onClick={e => e.stopPropagation()}
      >
        <header className="notices-drawer-header">
          <h2>{tx('notices.title', 'Notices')}</h2>
          <button className="modal-close" aria-label="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="notices-drawer-body">
          {sorted.length === 0 ? (
            <p className="modal-placeholder">
              {tx(
                'notices.empty',
                'The world is quiet. Notices about quests, memory, and world shifts will collect here.',
              )}
            </p>
          ) : (
            sorted.map(ev => <EventCard key={ev.id} event={ev} />)
          )}
        </div>
      </div>
    </div>
  );
}
