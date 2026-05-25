import type { FormEvent } from 'react';
import { useCallback, useRef, useState } from 'react';
import type { DiceRoll } from './DiceBubble';
import type { BubbleMenuState } from './components/chat/BubbleMenu';
import { GameScreen } from './components/GameScreen';
import { usePersonRegistry } from './hooks/usePersonRegistry';
import { useReducedMotion } from './hooks/useReducedMotion';
import { useSseSubscriptions } from './hooks/useSseSubscriptions';
import { useMentionTargets } from './hooks/useMentionTargets';
import { useLocationUpdates } from './hooks/useLocationUpdates';
import { usePlayerMessageCreated } from './hooks/usePlayerMessageCreated';
import { useSessionResetUi } from './hooks/useSessionResetUi';
import { useAutoScroll } from './hooks/useAutoScroll';
import { useTurnCancellation } from './hooks/useTurnCancellation';
import { useTurnSubmission } from './hooks/useTurnSubmission';
import { useFrontendTelemetry } from './hooks/useFrontendTelemetry';
import { useLatestRef } from './hooks/useLatestRef';
import { useAvailableLanguages } from './hooks/useAvailableLanguages';
import { useGameBootstrap } from './hooks/useGameBootstrap';
import { useDialogueActions } from './hooks/useDialogueActions';
import { useSystemEvents } from './hooks/useSystemEvents';
import { MobileBlocker } from './components/MobileBlocker';
import { logFrontend } from './lib/state';
import { localizedTalkMessage, localizedTravelMessage } from './lib/actionText';
import type { AffordanceAction } from './types/affordance';
import type { GameState, MentionTarget, TurnJobSnapshot } from './types/app';
import { useTranslation } from './i18n';
import { LanguagePicker } from './LanguagePicker';
import { getBrokerModel, getNarratorModel } from './bridge/platform';
import './App.css';

function App() {
  const {
    t,
    language: uiLanguage,
    ready: i18nReady,
    setLanguage,
  } = useTranslation();
  const reducedMotion = useReducedMotion();
  const personRegistry = usePersonRegistry();
  const [state, setState] = useState<GameState | null>(null);
  // Aspects/inner-voices feature removed 2026-05-14.
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loadingDetail, setLoadingDetail] = useState(
    'Waiting for Greenhaven backend...',
  );
  const [pendingJob, setPendingJob] = useState<TurnJobSnapshot | null>(null);
  const [liveDice, setLiveDice] = useState<DiceRoll[]>([]);
  const [diceRevealed, setDiceRevealed] = useState(false);
  const [diceCheckRequested, setDiceCheckRequested] = useState(false);
  const [optimisticUser, setOptimisticUser] = useState<string>('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const availableLanguages = useAvailableLanguages();
  const [brokerModel, setBrokerModel] = useState<string>(() =>
    getBrokerModel(),
  );
  const [narratorModel, setNarratorModel] = useState<string>(() =>
    getNarratorModel(),
  );
  const [affordances, setAffordances] = useState<AffordanceAction[]>([]);
  const [bubbleMenu, setBubbleMenu] = useState<BubbleMenuState | null>(null);
  const [dialoguePartner, setDialoguePartner] = useState<{
    id: number;
    name: string;
  } | null>(null);
  const [lastDialoguePartner, setLastDialoguePartner] = useState<{
    id: number;
    name: string;
  } | null>(null);
  const [, setAgentStep] = useState<{
    step: number;
    max: number;
    tool: string;
  } | null>(null);
  const [diceLog, setDiceLog] = useState<Record<number, DiceRoll[]>>({});
  const { systemEvents, updateSystemEvents, clearSystemEvents } =
    useSystemEvents();
  const scrollTurnSeq = useRef(0);
  const [scrollTurnKey, setScrollTurnKey] = useState<string | null>(null);
  const pendingTimelineKey =
    pendingJob &&
    pendingJob.status !== 'queued' &&
    (pendingJob.text || pendingJob.error)
      ? `pending:${pendingJob.id}`
      : null;
  const flowRef = useAutoScroll<HTMLDivElement>(
    [
      state?.messages.length,
      systemEvents.length,
      pendingTimelineKey,
      liveDice.length,
      diceCheckRequested,
      scrollTurnKey,
    ],
    { smooth: true, turnKey: scrollTurnKey },
  );
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  useFrontendTelemetry(state?.hero?.id, pendingJob?.id);

  const { send, continueScene, applyTurnResult } = useTurnSubmission({
    busy,
    t,
    setState,
    setDraft,
    setBusy,
    setError,
    setPendingJob,
    setOptimisticUser,
    setLiveDice,
    setDiceRevealed,
    setDiceCheckRequested,
  });

  const { retryLoadState } = useGameBootstrap({
    setState,
    setBusy,
    setError,
    setLoadingDetail,
    setPendingJob,
    applyTurnResult,
  });

  const pendingJobRef = useLatestRef<TurnJobSnapshot | null>(pendingJob);

  const armTimelineScroll = useCallback(() => {
    scrollTurnSeq.current += 1;
    setScrollTurnKey(`turn:${scrollTurnSeq.current}`);
  }, []);

  const sendWithTimelineScroll = useCallback(
    (message: string, actionId?: string, diceCheck?: boolean) => {
      if (!message.trim() || busy) return send(message, actionId, diceCheck);
      armTimelineScroll();
      return send(message, actionId, diceCheck);
    },
    [armTimelineScroll, busy, send],
  );

  const continueSceneWithTimelineScroll = useCallback(() => {
    armTimelineScroll();
    return continueScene();
  }, [armTimelineScroll, continueScene]);

  useSseSubscriptions({
    setAffordances,
    setDiceLog,
    setDialoguePartner,
    setLastDialoguePartner,
    setLiveDice,
    setDiceRevealed,
    setDiceCheckRequested,
    setPendingJob,
    setAgentStep,
    setOptimisticUser,
    setSystemEvents: updateSystemEvents,
  });

  const { handleSignOut, handleStartDialogue } = useDialogueActions({
    setDialoguePartner,
    setLastDialoguePartner,
    setBubbleMenu,
    setError,
    insertMention,
  });
  useTurnCancellation(pendingJobRef);
  useLocationUpdates(setState);

  const { mentionTargets, clearDiscoveredMentions } = useMentionTargets(
    state,
    affordances,
    uiLanguage,
  );
  const clearTransientSessionUi = useCallback(() => {
    setDraft('');
    setPendingJob(null);
    setOptimisticUser('');
    setLiveDice([]);
    setDiceRevealed(false);
    setDiceCheckRequested(false);
    setAgentStep(null);
    setDiceLog({});
    clearSystemEvents();
    setDialoguePartner(null);
    setLastDialoguePartner(null);
    setBubbleMenu(null);
    setError('');
    clearDiscoveredMentions();
    scrollTurnSeq.current = 0;
    setScrollTurnKey(null);
  }, [clearDiscoveredMentions, clearSystemEvents]);

  useSessionResetUi(clearTransientSessionUi, setBusy);
  usePlayerMessageCreated(pendingJobRef, setOptimisticUser, setPendingJob);

  function handleTravel(location: { id: number; name: string }) {
    if (busy || !location?.id) return;
    if (state?.currentLocation?.id === location.id) return;
    setBubbleMenu(null);
    void sendWithTimelineScroll(
      localizedTravelMessage(
        { name: location.name, type: 'location' },
        uiLanguage,
      ),
      `location:${location.id}`,
    );
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    await sendWithTimelineScroll(draft);
  }

  function insertMention(target: MentionTarget) {
    const mention = `@${target.name} `;
    const input = composerRef.current;
    let nextCaret = -1;
    setDraft((current) => {
      if (current.includes(mention.trim())) {
        return current;
      }
      const start = input?.selectionStart ?? current.length;
      const end = input?.selectionEnd ?? current.length;
      const before = current.slice(0, start);
      const after = current.slice(end);
      const needsLeadingSpace = before.length > 0 && !/\s$/.test(before);
      const sep = needsLeadingSpace ? ' ' : '';
      const next = `${before}${sep}${mention}${after}`;
      nextCaret = before.length + sep.length + mention.length;
      return next;
    });
    window.setTimeout(() => {
      const node = composerRef.current;
      if (!node) return;
      node.focus();
      if (nextCaret >= 0) {
        try {
          node.setSelectionRange(nextCaret, nextCaret);
        } catch {
          // setSelectionRange not supported on this input type; ignore.
        }
      }
    }, 0);
    logFrontend('info', 'mention_inserted', 'Inserted mention into composer', {
      entityId: target.id,
      name: target.name,
      type: target.type,
    });
  }

  function handleMention(target: MentionTarget) {
    logFrontend('info', 'mention_clicked', 'Opened menu via mention', {
      entityId: target.id,
      name: target.name,
      type: target.type,
    });
    const isPerson = (target.type ?? '').toLowerCase() === 'person';
    setBubbleMenu({
      messageId: -target.id,
      npcId: isPerson ? target.id : null,
      npcName: isPerson ? target.name : null,
      author: target.name,
      dice: [],
      entityId: target.id,
      entityName: target.name,
      entityType: (target.type ?? 'entity').toLowerCase(),
    });
  }

  if (i18nReady && uiLanguage === null) {
    return (
      <>
        <MobileBlocker />
        <LanguagePicker />
      </>
    );
  }

  if (!state) {
    return (
      <>
        <MobileBlocker />
        <main
          className="gh-boot-screen"
          role={error ? 'alert' : 'status'}
          aria-live="polite"
        >
          {/*
          <div className="gh-boot-mark">Greenhaven</div>
          */}
          {!error && (
            <>
              <p className="gh-boot-hint">
                <em>{t('ui.loading.title')}</em>
              </p>
              {loadingDetail && <p className="gh-boot-detail">{loadingDetail}</p>}
              <div className="gh-boot-spinner" aria-hidden />
            </>
          )}
          {error && (
            <>
              <p className="gh-boot-hint">{t('errors.runtime_open_failed')}</p>
              <pre className="gh-boot-error">{error}</pre>
              <button
                type="button"
                className="gh-boot-retry"
                onClick={retryLoadState}
              >
                {t('ui.loading.retry')}
              </button>
            </>
          )}
        </main>
      </>
    );
  }

  return (
    <>
      <MobileBlocker />
      <GameScreen
        state={state}
        draft={draft}
        setDraft={setDraft}
        busy={busy}
        error={error}
        uiLanguage={uiLanguage}
        t={t}
        settingsOpen={settingsOpen}
        setSettingsOpen={setSettingsOpen}
        availableLanguages={availableLanguages}
        setLanguage={setLanguage}
        brokerModel={brokerModel}
        setBrokerModel={setBrokerModel}
        narratorModel={narratorModel}
        setNarratorModel={setNarratorModel}
        onSignOut={handleSignOut}
        bubbleMenu={bubbleMenu}
        setBubbleMenu={setBubbleMenu}
        affordances={affordances}
        dialoguePartner={dialoguePartner}
        lastDialoguePartner={lastDialoguePartner}
        onStartDialogue={handleStartDialogue}
        onRunAction={(message, actionId) =>
          sendWithTimelineScroll(message, actionId)
        }
        onTravel={handleTravel}
        onNpcTalk={(id, name) =>
          void sendWithTimelineScroll(
            localizedTalkMessage({ name }, uiLanguage),
            `npc:${id}`,
          )
        }
        onSubmit={onSubmit}
        flowRef={flowRef}
        composerRef={composerRef}
        mentionTargets={mentionTargets}
        diceLog={diceLog}
        pendingJob={pendingJob}
        liveDice={liveDice}
        diceRevealed={diceRevealed}
        diceCheckRequested={diceCheckRequested}
        optimisticUser={optimisticUser}
        systemEvents={systemEvents}
        personRegistry={personRegistry}
        reducedMotion={reducedMotion}
        handleMention={handleMention}
        continueScene={continueSceneWithTimelineScroll}
      />
    </>
  );
}

export default App;
