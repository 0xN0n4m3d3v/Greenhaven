// Spec 139 v2 — NPC profile modal (TG contact-info equivalent).
//
// Opens when the player taps the NPC name in the chat header, or a
// contact row in the ChatList. Shows portrait, name, race/locale meta,
// dialogue state ("you are speaking with them"). Player-canon
// information ONLY — NPC private memory / thoughts stay hidden per
//

import {X, MessageCircle, Compass} from 'lucide-react';
import {Portrait} from '../npc/Portrait';
import type {PersonRegistry} from '../../hooks/usePersonRegistry';
import {
  relationshipBandLabel,
  type NearbyRelationship,
  type NearbyStatusBadge,
  type RelationshipBand,
} from '../../lib/presenceLabels';

export interface NPCProfileModalProps {
  npc: {
    id: number;
    name: string;
    status?: string;
    // FEAT-PRESENCE-1 — server-canonical bond + statuses; both
    // optional so legacy code paths that opened the modal without
    // enrichment still render (band shows as Unknown).
    relationship?: NearbyRelationship | null;
    statuses?: NearbyStatusBadge[];
  } | null;
  isCurrentPartner: boolean;
  personRegistry: PersonRegistry;
  onClose: () => void;
  onStartDialogue?: (id: number, name: string) => void;
  t: (key: string) => string;
}

export function NPCProfileModal({
  npc,
  isCurrentPartner,
  personRegistry,
  onClose,
  onStartDialogue,
  t,
}: NPCProfileModalProps) {
  if (!npc) return null;
  const tx = (k: string, fb: string) => (t(k) === k ? fb : t(k));
  const record = npc.id > 0 ? personRegistry?.get?.(npc.id) : null;
  const portraitSet = record?.portrait_set ?? undefined;
  // FEAT-PRESENCE-1 — render server-canonical bond band + public
  // status badges. Hidden NPC thoughts NEVER appear here; only the
  // whitelisted public status kinds from `actor_statuses`.
  const band: RelationshipBand | null = npc.relationship?.band ?? null;
  const bandLabel = relationshipBandLabel(band, t);
  const statuses = npc.statuses ?? [];
  const bondHeading = tx('ui.presence.bond_label', 'Bond');
  const statusHeading = tx('ui.presence.status_label', 'Status');

  return (
    <div className="modal-backdrop gh-modal-backdrop" onClick={onClose}>
      <div
        className="modal npc-profile-modal gh-panel gh-npc-profile"
        role="dialog"
        aria-modal
        onClick={e => e.stopPropagation()}
      >
        <button className="modal-close gh-control" aria-label="Close" onClick={onClose}>
          <X size={18} />
        </button>

        <div className="npc-profile-hero">
          <Portrait
            npcId={npc.id}
            name={npc.name}
            portraitSet={portraitSet}
            size="lg"
          />
          <h2 className="npc-profile-name">{npc.name}</h2>
          {npc.status && (
            <div className="npc-profile-status">
              <Compass size={12} /> {npc.status}
            </div>
          )}
        </div>

        {(band || statuses.length > 0) && (
          <div className="npc-profile-presence">
            {band && (
              <div className="npc-profile-bond">
                <span className="npc-profile-presence-label">{bondHeading}</span>
                <span
                  className={`npc-profile-band npc-profile-band-${band}`}
                  title={
                    typeof npc.relationship?.count === 'number'
                      ? `${bandLabel} (${npc.relationship.count})`
                      : bandLabel
                  }
                >
                  {bandLabel}
                </span>
              </div>
            )}
            {statuses.length > 0 && (
              <div className="npc-profile-status-list">
                <span className="npc-profile-presence-label">
                  {statusHeading}
                </span>
                <ul className="npc-profile-status-badges">
                  {statuses.map(s => (
                    <li
                      key={s.kind}
                      className="npc-profile-status-badge"
                      title={`${s.kind}: ${s.value}`}
                    >
                      <span className="npc-profile-status-kind">{s.kind}</span>
                      <span className="npc-profile-status-value">
                        {s.value}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {!isCurrentPartner && (
          <div className="npc-profile-actions">
            <button
              type="button"
              className="modal-action primary gh-control"
              onClick={() => {
                onStartDialogue?.(npc.id, npc.name);
                onClose();
              }}
            >
              <MessageCircle size={14} />
              {tx('npc_profile.start_dialogue', 'Speak with them')}
            </button>
          </div>
        )}

        <div className="npc-profile-meta">
          <p className="npc-profile-hint">
            {tx(
              'npc_profile.hint',
              'You only see what you yourself have noticed. What they remember and what they think is theirs alone.',
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
