import { useMemo, useRef, useState, type FormEvent, type RefObject } from 'react';
import type { DiceRoll } from '../DiceBubble';
import { BubbleMenu, type BubbleMenuState } from './chat/BubbleMenu';
import { ChatComposer } from './chat/ChatComposer';
import { ChatHeader } from './chat/ChatHeader';
import { DialogueBanner } from './chat/DialogueBanner';
import { MessageFlow } from './chat/MessageFlow';
import { StreamingTokens } from './chat/StreamingTokens';
import { TypingPulse } from './chat/TypingPulse';
import { Portrait } from './npc/Portrait';
import { SettingsModal } from './modals/SettingsModal';
import { NPCProfileModal } from './modals/NPCProfileModal';
import { CityMapModal } from './map/CityMapModal';
import { ChatList, type ChatListNearby } from './rail/ChatList';
import type {
  NearbyRelationship,
  NearbyStatusBadge,
} from '../lib/presenceLabels';
import { SceneSurfaceStrip } from './scene/SceneSurfaceStrip';
import { CharacterStateSurface } from './surfaces/CharacterStateSurface';
import { InventorySurface } from './surfaces/InventorySurface';
import { NoticeJournalSurface } from './surfaces/NoticeJournalSurface';
import { PlayerSurfaceShell } from './surfaces/PlayerSurfaceShell';
import { QuestDashboardSurface } from './surfaces/QuestDashboardSurface';
import { RelationshipsSurface } from './surfaces/RelationshipsSurface';
import { useRailCollapsed } from '../hooks/useRailCollapsed';
import { useGameHotkeys, type SurfaceKind } from '../hooks/useGameHotkeys';
import type { i18n } from '../bridge/platform';
import { safeArray } from '../lib/state';
import type { PersonRegistry } from '../hooks/usePersonRegistry';
import type { SystemEvent } from './chat/EventCard';
import type { AffordanceAction } from '../types/affordance';
import type { GameState, MentionTarget, TurnJobSnapshot } from '../types/app';

type TranslationFn = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

interface DialoguePartner {
  id: number;
  name: string;
}

interface GameScreenProps {
  state: GameState;
  draft: string;
  setDraft: (next: string) => void;
  busy: boolean;
  error: string;
  uiLanguage: string | null;
  t: TranslationFn;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  availableLanguages: i18n.Language[];
  setLanguage: (language: string) => Promise<void>;
  brokerModel: string;
  setBrokerModel: (model: string) => void;
  narratorModel: string;
  setNarratorModel: (model: string) => void;
  onSignOut: () => void;
  bubbleMenu: BubbleMenuState | null;
  setBubbleMenu: (menu: BubbleMenuState | null) => void;
  affordances: AffordanceAction[];
  dialoguePartner: DialoguePartner | null;
  lastDialoguePartner: DialoguePartner | null;
  onStartDialogue: (npcId: number, npcName: string) => void;
  onRunAction: (message: string, actionId: string) => void | Promise<void>;
  onTravel: (location: { id: number; name: string }) => void;
  onNpcTalk: (id: number, name: string) => void;
  onSubmit: (event: FormEvent) => void;
  flowRef: RefObject<HTMLDivElement | null>;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  mentionTargets: MentionTarget[];
  diceLog: Record<number, DiceRoll[]>;
  pendingJob: TurnJobSnapshot | null;
  liveDice: DiceRoll[];
  diceRevealed: boolean;
  diceCheckRequested: boolean;
  optimisticUser: string;
  systemEvents: SystemEvent[];
  personRegistry: PersonRegistry;
  reducedMotion: boolean;
  handleMention: (target: MentionTarget) => void;
  continueScene: () => void;
}

export function GameScreen({
  state,
  draft,
  setDraft,
  busy,
  error,
  uiLanguage,
  t,
  settingsOpen,
  setSettingsOpen,
  availableLanguages,
  setLanguage,
  brokerModel,
  setBrokerModel,
  narratorModel,
  setNarratorModel,
  onSignOut,
  bubbleMenu,
  setBubbleMenu,
  affordances,
  dialoguePartner,
  lastDialoguePartner,
  onStartDialogue,
  onRunAction,
  onTravel,
  onNpcTalk,
  onSubmit,
  flowRef,
  composerRef,
  mentionTargets,
  diceLog,
  pendingJob,
  liveDice,
  diceRevealed,
  diceCheckRequested,
  optimisticUser,
  systemEvents,
  personRegistry,
  reducedMotion,
  handleMention,
  continueScene,
}: GameScreenProps) {
  useRailCollapsed();
  const [cityMapOpen, setCityMapOpen] = useState(false);
  const [activeSurface, setActiveSurface] = useState<SurfaceKind | null>(null);
  const [npcProfileFor, setNpcProfileFor] = useState<{
    id: number;
    name: string;
    status?: string;
    relationship?: NearbyRelationship | null;
    statuses?: NearbyStatusBadge[];
  } | null>(null);
  // FEAT-SHELL-1 follow-up — track whether the active surface was
  // opened via a hotkey vs. a menu/chip click. Hotkey opens fire
  // while focus is on `body` (the hotkey skips when typing), so
  // Radix has no usable trigger to restore focus to on close. We
  // pass `composerRef` to the shell as a deterministic landing
  // zone in that case; menu-triggered opens leave the ref empty
  // and let Radix restore focus to the menu button.
  const openedViaHotkey = useRef(false);
  const openSurfaceFromMenu = (kind: SurfaceKind) => {
    openedViaHotkey.current = false;
    setActiveSurface(kind);
  };
  const closeActiveSurface = () => {
    setActiveSurface(null);
    openedViaHotkey.current = false;
  };
  const nearby = safeArray(state.nearby) as ChatListNearby[];

  // FEAT-SHELL-1 — RPG hotkeys: J=journal, Q=quests, I=inventory,
  // M=map, P=character state, Esc=close.
  useGameHotkeys({
    openMap: () => setCityMapOpen(true),
    openSurface: (kind) => {
      openedViaHotkey.current = true;
      setActiveSurface(kind);
    },
    closeAll: () => {
      setCityMapOpen(false);
      closeActiveSurface();
      setNpcProfileFor(null);
    },
  });
  const composerMentionTargets = useMemo(
    () =>
      mentionTargets.filter(
        (target) => (target.type ?? '').toLowerCase() === 'person',
      ),
    [mentionTargets],
  );
  return (
    <main className="game-shell gh-screen gh-game-shell">
      {/* Whole-bubble menus stay disabled so text selection and native
          copy work. Inline @mentions still open the action menu. */}
      {bubbleMenu && (
        <BubbleMenu
          menu={bubbleMenu}
          affordances={affordances}
          language={uiLanguage}
          t={t}
          onClose={() => setBubbleMenu(null)}
          onStartDialogue={onStartDialogue}
          onRunAction={(message, actionId) => {
            setBubbleMenu(null);
            void onRunAction(message, actionId);
          }}
        />
      )}
      {settingsOpen && (
        <SettingsModal
          uiLanguage={uiLanguage ?? 'en'}
          availableLanguages={availableLanguages}
          setLanguage={setLanguage}
          brokerModel={brokerModel}
          setBrokerModel={setBrokerModel}
          narratorModel={narratorModel}
          setNarratorModel={setNarratorModel}
          onSignOut={onSignOut}
          onClose={() => setSettingsOpen(false)}
          t={t}
          playerId={state.hero?.id}
        />
      )}
      {cityMapOpen && (
        <CityMapModal
          currentLocation={state.currentLocation}
          locations={safeArray(state.locations)}
          mapNodes={
            ((state as unknown as { mapNodes?: unknown }).mapNodes ??
              []) as Array<{
              id: number;
              name: string;
              kind: string;
              location_kind: string | null;
              x: number;
              y: number;
              color: string | null;
              topology_parent_id: number | null;
              is_current: boolean;
              is_exit: boolean;
              visual_asset_urls?: Record<string, string> | null;
            }>
          }
          nearby={nearby}
          busy={busy}
          onClose={() => setCityMapOpen(false)}
          onTravel={onTravel}
          t={t}
        />
      )}

      <aside className="contact-rail chatlist-rail gh-panel gh-game-rail">
        <ChatList
          hero={state.hero}
          currentLocation={state.currentLocation}
          nearby={nearby}
          dialoguePartnerId={dialoguePartner?.id ?? null}
          dialoguePartnerName={dialoguePartner?.name ?? null}
          unreadCount={0}
          onTalk={(id, name) => {
            const row = nearby.find((n) => n.id === id);
            // FEAT-PRESENCE-1 — pass server-canonical bond + status
            // badges into the NPC profile modal so it can render the
            // same indicators the rail shows.
            setNpcProfileFor({
              id,
              name,
              status: row?.status,
              relationship: row?.relationship ?? null,
              statuses: row?.statuses ?? [],
            });
          }}
          onOpenScene={() => setCityMapOpen(true)}
          onOpenNotices={() => openSurfaceFromMenu('journal')}
          onOpenSelfProfile={() => openSurfaceFromMenu('character')}
          personRegistry={personRegistry}
          t={t}
        />
      </aside>

      {npcProfileFor && (
        <NPCProfileModal
          npc={npcProfileFor}
          isCurrentPartner={dialoguePartner?.id === npcProfileFor.id}
          personRegistry={personRegistry}
          onClose={() => setNpcProfileFor(null)}
          onStartDialogue={(id, name) => onNpcTalk(id, name)}
          t={t}
        />
      )}

      {/* FEAT-SHELL-1 — single LitRPG player-surface shell. One Radix
          dialog hosts whichever surface the player triggered via the
          I / Q / J / P hotkey or the ChatHeader menu. The hotkey-
          opened path supplies `composerRef` as a deterministic
          focus-restore fallback; menu-opened paths leave it empty
          so Radix restores focus to the menu button naturally. */}
      {activeSurface && (
        <PlayerSurfaceShell
          surface={activeSurface}
          title={t(`ui.surface.${activeSurface}.title`)}
          closeLabel={t('ui.surface.close')}
          onClose={closeActiveSurface}
          fallbackFocusRef={
            openedViaHotkey.current ? composerRef : undefined
          }
        >
          {activeSurface === 'inventory' && (
            <InventorySurface
              t={t}
              playerId={state.hero?.id ?? 0}
              language={uiLanguage}
            />
          )}
          {activeSurface === 'quests' && (
            <QuestDashboardSurface
              playerId={state.hero?.id ?? 0}
              language={uiLanguage}
              t={t}
            />
          )}
          {activeSurface === 'journal' && (
            <NoticeJournalSurface
              playerId={state.hero?.id ?? 0}
              language={uiLanguage}
              t={t}
            />
          )}
          {activeSurface === 'character' && (
            <CharacterStateSurface
              playerId={state.hero?.id ?? 0}
              language={uiLanguage}
              t={t}
            />
          )}
          {activeSurface === 'bonds' && (
            <RelationshipsSurface
              playerId={state.hero?.id ?? 0}
              language={uiLanguage}
              t={t}
            />
          )}
        </PlayerSurfaceShell>
      )}

      <section className="chat-stage gh-panel gh-game-stage">
        <ChatHeader
          currentLocationName={state.currentLocation.name}
          sceneName={state.currentScene?.name}
          dialoguePartner={dialoguePartner}
          personRegistry={personRegistry}
          onOpenMap={() => setCityMapOpen(true)}
          onOpenSurface={openSurfaceFromMenu}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenPartnerProfile={() => {
            if (dialoguePartner) {
              const row = nearby.find((n) => n.id === dialoguePartner.id);
              setNpcProfileFor({
                id: dialoguePartner.id,
                name: dialoguePartner.name,
                status: row?.status,
                relationship: row?.relationship ?? null,
                statuses: row?.statuses ?? [],
              });
            }
          }}
          t={t}
        />

        <SceneSurfaceStrip locationId={state.currentLocation?.id ?? null} />
        {error && <div className="error-banner">{error}</div>}
        <DialogueBanner
          active={dialoguePartner}
          last={lastDialoguePartner}
          onResume={onStartDialogue}
          t={t}
        />
        {/* PartnerSwitch removed — NPC selection lives in ChatList rows. */}
        <MessageFlow
          state={state}
          flowRef={flowRef}
          mentionTargets={mentionTargets}
          diceLog={diceLog}
          pendingJob={pendingJob}
          liveDice={liveDice}
          diceRevealed={diceRevealed}
          diceCheckRequested={diceCheckRequested}
          optimisticUser={optimisticUser}
          busy={busy}
          personRegistry={personRegistry}
          t={t}
          setBubbleMenu={setBubbleMenu}
          handleMention={handleMention}
          continueScene={continueScene}
          onRunAction={onRunAction}
          onReplyTo={(msg) => {
            // Spec 139 v2 — pre-fill composer with a one-line quote of
            // the message being replied to. Author + first ~120 chars,
            // markdown-blockquote style; the broker can interpret the
            // ">" prefix as a reply reference.
            const trimmed = msg.text.replace(/\s+/g, ' ').trim().slice(0, 120);
            const ellipsis = msg.text.length > 120 ? '…' : '';
            const quote = `> ${msg.author}: «${trimmed}${ellipsis}»\n\n`;
            setDraft(quote + (draft.startsWith(quote) ? '' : draft));
            composerRef.current?.focus();
          }}
          systemEvents={systemEvents}
          renderPendingText={(text) => (
            <StreamingTokens text={text} animated={!reducedMotion} />
          )}
          renderBubbleAuthor={(message) =>
            message.tone === 'npc' && message.authorId > 0 ? (
              <Portrait
                npcId={message.authorId}
                name={message.author}
                portraitSet={
                  personRegistry.get(message.authorId)?.portrait_set ??
                  undefined
                }
                size="sm"
              />
            ) : null
          }
        />

        <TypingPulse
          visible={
            !!pendingJob &&
            pendingJob.status !== 'queued' &&
            !pendingJob.text &&
            !pendingJob.error
          }
          author={
            dialoguePartner?.name ??
            (() => {
              const v = t('ui.typing.narrator');
              return v === 'ui.typing.narrator' ? 'the narrator' : v;
            })()
          }
          verb={(() => {
            const v = t('ui.typing.composing');
            return v === 'ui.typing.composing' ? 'is composing' : v;
          })()}
          hue={
            dialoguePartner
              ? (personRegistry?.get?.(dialoguePartner.id)?.persona_hue ?? null)
              : null
          }
          queued={pendingJob?.status === 'queued'}
        />

        <ChatComposer
          draft={draft}
          setDraft={setDraft}
          busy={busy}
          onSubmit={onSubmit}
          composerRef={composerRef}
          t={t}
          mentionTargets={composerMentionTargets}
          personRegistry={personRegistry}
        />
      </section>
    </main>
  );
}
