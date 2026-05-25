// Spec 139 v2 — Messenger ChatList.
//
// Replaces the old "stat sidebar" model. The left rail is now a
// **list of conversations**: pinned current dialogue partner at top,
// nearby NPCs as contact rows, location-as-channel, system notices
// channel, and your own profile pinned to the bottom (TG-style).
//
// Stat surfaces (HP / currency / conditions / trauma / inventory /
// quests / map) are NOT in this list anymore — they live behind the
// own-profile click and the chat-header menu.

import type {ReactNode} from 'react';
import {Map as MapIcon, ScrollText, User} from 'lucide-react';
import {Portrait} from '../npc/Portrait';
import type {GameState} from '../../types/app';
import type {PersonRegistry} from '../../hooks/usePersonRegistry';
import {
  relationshipBandLabel,
  type NearbyRelationship,
  type NearbyStatusBadge,
  type RelationshipBand,
} from '../../lib/presenceLabels';

export interface ChatListNearby {
  id: number;
  name: string;
  status?: string;
  /** FEAT-PRESENCE-1 — server-canonical bond band. `null` when no
   *  relationship has been recorded for this player → renders as
   *  a neutral / unknown badge. */
  relationship?: NearbyRelationship | null;
  /** FEAT-PRESENCE-1 — small list of public actor-status badges. */
  statuses?: NearbyStatusBadge[];
}

export interface ChatListProps {
  hero: GameState['hero'];
  currentLocation: GameState['currentLocation'];
  nearby: ChatListNearby[];
  dialoguePartnerId: number | null;
  dialoguePartnerName: string | null;
  unreadCount?: number;
  onTalk: (id: number, name: string) => void;
  onOpenScene: () => void;
  onOpenNotices: () => void;
  onOpenSelfProfile: () => void;
  personRegistry: PersonRegistry;
  t: (key: string) => string;
}

export function ChatList({
  hero,
  currentLocation,
  nearby,
  dialoguePartnerId,
  unreadCount = 0,
  onTalk,
  onOpenScene,
  onOpenNotices,
  onOpenSelfProfile,
  personRegistry,
  t,
}: ChatListProps) {
  const tx = (key: string, fallback: string) => {
    const v = t(key);
    return v === key ? fallback : v;
  };

  // Pinned dialogue partner at top (if any), then non-partner nearby NPCs.
  const partnerRow = dialoguePartnerId
    ? nearby.find(n => n.id === dialoguePartnerId)
    : null;
  const otherNearby = nearby.filter(n => n.id !== dialoguePartnerId);
  const presenceT = t;

  return (
    <div className="chatlist">
      {/* Pinned: current dialogue partner */}
      {partnerRow && (
        <>
          <div className="chatlist-eyebrow">{tx('chatlist.pinned', 'Pinned')}</div>
          <ContactRow
            npc={partnerRow}
            isPinned
            personRegistry={personRegistry}
            onClick={() => onTalk(partnerRow.id, partnerRow.name)}
            t={presenceT}
          />
        </>
      )}

      {/* Nearby NPCs — always show the section so the layout stays
          consistent. When empty, render a quiet placeholder. */}
      <div className="chatlist-eyebrow">{tx('chatlist.nearby', 'Nearby')}</div>
      {otherNearby.length > 0 ? (
        otherNearby.map(n => (
          <ContactRow
            key={n.id}
            npc={n}
            personRegistry={personRegistry}
            onClick={() => onTalk(n.id, n.name)}
            t={presenceT}
          />
        ))
      ) : (
        <div className="chatlist-empty">
          {tx('chatlist.nearby_empty', 'No one visible here.')}
        </div>
      )}

      {/* Channels (location / notices) */}
      <div className="chatlist-eyebrow">{tx('chatlist.channels', 'Channels')}</div>
      <ChannelRow
        icon={<MapIcon size={16} />}
        title={currentLocation?.name || tx('chatlist.scene_default', 'Current scene')}
        sub={tx('chatlist.scene_sub', "The world's voice")}
        accent="ember"
        onClick={onOpenScene}
      />
      <ChannelRow
        icon={<ScrollText size={16} />}
        title={tx('chatlist.notices', 'Notices')}
        sub={tx('chatlist.notices_sub', 'Quests · memory · world shifts')}
        accent="link"
        badge={unreadCount > 0 ? String(unreadCount) : null}
        onClick={onOpenNotices}
      />

      {/* Spacer pushes self-profile to the bottom */}
      <div className="chatlist-spacer" />

      {/* Self profile pinned at bottom — click to open own profile modal */}
      <button
        type="button"
        className="chatlist-selfprofile"
        onClick={onOpenSelfProfile}
        aria-label={tx('chatlist.self_profile', 'Your profile')}
      >
        <div className="chatlist-selfprofile-avatar">
          {hero?.name ? hero.name.trim()[0]?.toUpperCase() ?? <User size={16} /> : <User size={16} />}
        </div>
        <div className="chatlist-selfprofile-text">
          <div className="chatlist-selfprofile-name">
            {hero?.name || tx('ui.brand.name', 'You')}
          </div>
          <div className="chatlist-selfprofile-sub">
            {tx('chatlist.self_sub', 'Tap for profile, inventory, quests')}
          </div>
        </div>
      </button>
    </div>
  );
}

function ContactRow({
  npc,
  isPinned,
  personRegistry,
  onClick,
  t,
}: {
  npc: ChatListNearby;
  isPinned?: boolean;
  personRegistry: PersonRegistry;
  onClick: () => void;
  t: (key: string) => string;
}) {
  const record = npc.id > 0 ? personRegistry?.get?.(npc.id) : null;
  const portraitSet = record?.portrait_set ?? undefined;
  // FEAT-PRESENCE-1 — render compact bond chip + leading status pip
  // beside the contact row sub-text. Server is the source of truth;
  // we only display what it sent.
  const band: RelationshipBand | null = npc.relationship?.band ?? null;
  const bandLabel = relationshipBandLabel(band, t);
  const leadingStatus = npc.statuses?.[0] ?? null;
  const moreStatusCount =
    npc.statuses && npc.statuses.length > 1 ? npc.statuses.length - 1 : 0;
  return (
    <button
      type="button"
      className={`chatlist-row contact-row${isPinned ? ' pinned' : ''}`}
      onClick={onClick}
    >
      <Portrait
        npcId={npc.id}
        name={npc.name}
        portraitSet={portraitSet}
        size="sm"
      />
      <div className="chatlist-row-text">
        <div className="chatlist-row-name">{npc.name}</div>
        <div className="chatlist-row-presence">
          {band && (
            <span
              className={`chatlist-band-chip chatlist-band-${band}`}
              aria-label={`${bandLabel}`}
              title={`${bandLabel}${
                typeof npc.relationship?.count === 'number'
                  ? ` (${npc.relationship.count})`
                  : ''
              }`}
            >
              {bandLabel}
            </span>
          )}
          {leadingStatus && (
            <span
              className="chatlist-status-pip"
              aria-label={leadingStatus.kind}
              title={`${leadingStatus.kind}: ${leadingStatus.value}`}
            >
              {leadingStatus.kind}
              {moreStatusCount > 0 ? ` +${moreStatusCount}` : ''}
            </span>
          )}
          {npc.status && !band && !leadingStatus && (
            <span className="chatlist-row-sub">{npc.status}</span>
          )}
        </div>
      </div>
    </button>
  );
}

function ChannelRow({
  icon,
  title,
  sub,
  accent,
  badge,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  sub: string;
  accent: 'ember' | 'link';
  badge?: string | null;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`chatlist-row channel-row accent-${accent}`}
      onClick={onClick}
    >
      <div className="chatlist-channel-icon">{icon}</div>
      <div className="chatlist-row-text">
        <div className="chatlist-row-name">{title}</div>
        <div className="chatlist-row-sub">{sub}</div>
      </div>
      {badge && <div className="chatlist-row-badge">{badge}</div>}
    </button>
  );
}
