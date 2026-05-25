// Spec 139 v2 — TG-style chat header.
//
// Two-tier presentation:
//   line 1: avatar + name. Avatar + name are clickable → opens the
//           target's profile (NPC profile if dialogue partner exists;
//           location info otherwise).
//   line 2: status sub — partner's "in <location>" or "the world's voice".
//
// Right side: hamburger menu (Map / Profile / Settings).
//
// Nearby NPCs row was removed — that role belongs to ChatList now.

import {useState, useRef, useEffect} from 'react';
import {Menu, Map as MapIcon, Settings as SettingsIcon, Backpack, ScrollText, NotebookText, UserSquare2, HeartHandshake} from 'lucide-react';
import {Portrait} from '../npc/Portrait';
import type {PersonRegistry} from '../../hooks/usePersonRegistry';
import type {SurfaceKind} from '../../hooks/useGameHotkeys';

interface DialoguePartner {
  id: number;
  name: string;
}

interface Props {
  currentLocationName: string;
  sceneName?: string;
  dialoguePartner: DialoguePartner | null;
  personRegistry: PersonRegistry;
  onOpenMap: () => void;
  onOpenSurface: (kind: SurfaceKind) => void;
  onOpenSettings: () => void;
  onOpenPartnerProfile: () => void;
  t: (key: string) => string;
}

export function ChatHeader({
  currentLocationName,
  sceneName,
  dialoguePartner,
  personRegistry,
  onOpenMap,
  onOpenSurface,
  onOpenSettings,
  onOpenPartnerProfile,
  t,
}: Props) {
  const tx = (k: string, fb: string) => (t(k) === k ? fb : t(k));
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onClickAway(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    }
    document.addEventListener('mousedown', onClickAway);
    return () => document.removeEventListener('mousedown', onClickAway);
  }, [menuOpen]);

  const portraitSet = dialoguePartner
    ? personRegistry?.get?.(dialoguePartner.id)?.portrait_set ?? undefined
    : undefined;

  const title = dialoguePartner?.name ?? currentLocationName;
  const subParts: string[] = [];
  if (dialoguePartner) {
    if (currentLocationName) subParts.push(`${tx('chat_header.in', 'in')} ${currentLocationName}`);
    if (sceneName?.trim()) subParts.push(sceneName);
  } else {
    subParts.push(tx('chat_header.scene_sub', "the world's voice"));
    if (sceneName?.trim()) subParts.push(sceneName);
  }

  return (
    <header className="chat-header tg">
      <button
        type="button"
        className="chat-header-target"
        onClick={dialoguePartner ? onOpenPartnerProfile : onOpenMap}
        aria-label={
          dialoguePartner
            ? tx('chat_header.open_partner', `Profile of ${dialoguePartner.name}`)
            : tx('chat_header.open_map', 'Open map')
        }
      >
        {dialoguePartner ? (
          <Portrait
            npcId={dialoguePartner.id}
            name={dialoguePartner.name}
            portraitSet={portraitSet}
            size="sm"
          />
        ) : (
          <div className="chat-header-scene-avatar">
            <MapIcon size={18} />
          </div>
        )}
        <div className="chat-header-text">
          <h2 className="chat-header-name">{title}</h2>
          {subParts.length > 0 && (
            <small className="chat-header-sub">{subParts.join(' · ')}</small>
          )}
        </div>
      </button>

      <div className="chat-header-menu" ref={menuRef}>
        <button
          type="button"
          className="chat-header-menu-trigger"
          aria-label={tx('chat_header.menu', 'Menu')}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen(v => !v)}
        >
          <Menu size={18} />
        </button>
        {menuOpen && (
          <div className="chat-header-menu-popover" role="menu">
            <button
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                onOpenMap();
              }}
            >
              <span className="chat-header-menu-icon"><MapIcon size={14} /></span>
              <span className="chat-header-menu-label">{tx('chat_header.menu_map', 'Map')}</span>
              <kbd>M</kbd>
            </button>
            <button
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                onOpenSurface('character');
              }}
            >
              <span className="chat-header-menu-icon"><UserSquare2 size={14} /></span>
              <span className="chat-header-menu-label">{t('ui.surface.character.title')}</span>
              <kbd>P</kbd>
            </button>
            <button
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                onOpenSurface('inventory');
              }}
            >
              <span className="chat-header-menu-icon"><Backpack size={14} /></span>
              <span className="chat-header-menu-label">{t('ui.surface.inventory.title')}</span>
              <kbd>I</kbd>
            </button>
            <button
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                onOpenSurface('quests');
              }}
            >
              <span className="chat-header-menu-icon"><ScrollText size={14} /></span>
              <span className="chat-header-menu-label">{t('ui.surface.quests.title')}</span>
              <kbd>Q</kbd>
            </button>
            <button
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                onOpenSurface('journal');
              }}
            >
              <span className="chat-header-menu-icon"><NotebookText size={14} /></span>
              <span className="chat-header-menu-label">{t('ui.surface.journal.title')}</span>
              <kbd>J</kbd>
            </button>
            <button
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                onOpenSurface('bonds');
              }}
            >
              <span className="chat-header-menu-icon"><HeartHandshake size={14} /></span>
              <span className="chat-header-menu-label">{t('ui.surface.bonds.title')}</span>
              <kbd>B</kbd>
            </button>
            <button
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                onOpenSettings();
              }}
            >
              <span className="chat-header-menu-icon"><SettingsIcon size={14} /></span>
              <span className="chat-header-menu-label">{tx('chat_header.menu_settings', 'Settings')}</span>
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
