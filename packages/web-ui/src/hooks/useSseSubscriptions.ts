// Spec 29 §A.3 — collapses 5 EventsOn subscription useEffects from
// App.tsx into a single hook. Setters get passed in; cleanup is
// handled internally.

import {useEffect, type Dispatch, type SetStateAction} from 'react';
import {EventsOn} from '../bridge/platform';
import type {DiceRoll} from '../DiceBubble';
import type {SystemEvent} from '../components/chat/EventCard';
import {compareSystemEvents} from '../components/chat/eventOrdering';
import {isAffordanceAction, type AffordanceAction} from '../types/affordance';
import type {TurnJobSnapshot} from '../types/app';

export interface SseSubscriptionsArgs {
  setAffordances: (next: AffordanceAction[]) => void;
  setDiceLog: (
    update: (prev: Record<number, DiceRoll[]>) => Record<number, DiceRoll[]>,
  ) => void;
  setDialoguePartner: (next: {id: number; name: string} | null) => void;
  setLastDialoguePartner: (next: {id: number; name: string}) => void;
  setLiveDice: (update: (prev: DiceRoll[]) => DiceRoll[]) => void;
  setDiceRevealed: (next: boolean) => void;
  setDiceCheckRequested: (next: boolean) => void;
  setPendingJob: (
    update: (prev: TurnJobSnapshot | null) => TurnJobSnapshot | null,
  ) => void;
  setAgentStep: (
    next: {step: number; max: number; tool: string} | null,
  ) => void;
  setOptimisticUser: Dispatch<SetStateAction<string>>;
  // Spec 38 follow-up — LitRPG-style system event cards. Bridge merges
  // memory:added / quest:* / string:changed / damage:dealt / xp:* /
  // inspiration:* into a single 'system:event' channel; we accumulate
  // them into a per-turn buffer so they render between bubbles.
  setSystemEvents: (
    update: (prev: SystemEvent[]) => SystemEvent[],
  ) => void;
}

export function useSseSubscriptions(args: SseSubscriptionsArgs): void {
  const {
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
    setSystemEvents,
  } = args;

  useEffect(() => {
    const off = EventsOn('affordances:updated', (...evArgs: unknown[]) => {
      const list = evArgs[0];
      if (!Array.isArray(list)) return;
      setAffordances(list.filter(isAffordanceAction));
    });
    return () => off();
  }, [setAffordances]);

  useEffect(() => {
    const off = EventsOn('dice:persisted', (...evArgs: unknown[]) => {
      const payload = evArgs[0] as
        | {messageId?: number; dice?: DiceRoll[]}
        | undefined;
      if (
        !payload ||
        typeof payload.messageId !== 'number' ||
        !Array.isArray(payload.dice)
      )
        return;
      setDiceLog(prev => ({...prev, [payload.messageId!]: payload.dice!}));
    });
    return () => off();
  }, [setDiceLog]);

  useEffect(() => {
    const off = EventsOn('dialogue:engaged', (...evArgs: unknown[]) => {
      const payload = evArgs[0] as {id?: number; name?: string} | undefined;
      if (!payload || typeof payload.id !== 'number' || payload.id <= 0) return;
      const next = {id: payload.id, name: payload.name ?? ''};
      setDialoguePartner(next);
      setLastDialoguePartner(next);
    });
    return () => off();
  }, [setDialoguePartner, setLastDialoguePartner]);

  useEffect(() => {
    const off = EventsOn('dialogue:partner_switched', (...evArgs: unknown[]) => {
      const payload = evArgs[0] as
        | {
            id?: number | null;
            name?: string | null;
            partner_id?: number | null;
            partner_name?: string | null;
          }
        | undefined;
      if (!payload) return;
      const id = payload.id ?? payload.partner_id ?? null;
      if (typeof id === 'number' && id > 0) {
        const next = {
          id,
          name: payload.name ?? payload.partner_name ?? '',
        };
        setDialoguePartner(next);
        setLastDialoguePartner(next);
        return;
      }
      setDialoguePartner(null);
    });
    return () => off();
  }, [setDialoguePartner, setLastDialoguePartner]);

  useEffect(() => {
    const streamRef = {text: '', firstTokenSeen: false};
    const offToken = EventsOn('turn:token', (...evArgs: unknown[]) => {
      const piece = String(evArgs[0] ?? '');
      if (!piece) return;
      if (!streamRef.firstTokenSeen) {
        streamRef.firstTokenSeen = true;
        setDiceCheckRequested(false);
      }
      streamRef.text += piece;
      const buffered = streamRef.text;
      setPendingJob(current => {
        if (!current) return current;
        if (
          current.status === 'done' ||
          current.status === 'error' ||
          current.status === 'canceled'
        ) {
          return current;
        }
        return {...current, status: 'running', text: buffered};
      });
    });
    const offDone = EventsOn('turn:stream_done', (...evArgs: unknown[]) => {
      const finalText = String(evArgs[0] ?? streamRef.text);
      setDiceRevealed(true);
      setDiceCheckRequested(false);
      streamRef.text = '';
      streamRef.firstTokenSeen = false;
      setPendingJob(current => {
        if (!current) return current;
        if (
          current.status === 'done' ||
          current.status === 'error' ||
          current.status === 'canceled'
        ) {
          return current;
        }
        return {...current, text: finalText};
      });
    });
    const offDice = EventsOn('dice:rolled', (...evArgs: unknown[]) => {
      const payload = evArgs[0] as DiceRoll | undefined;
      if (!payload) return;
      setLiveDice(prev => [...prev, payload]);
      setDiceCheckRequested(false);
      if (streamRef.firstTokenSeen) {
        setDiceRevealed(true);
      }
    });
    const offAgent = EventsOn('agent:step', (...evArgs: unknown[]) => {
      const payload = evArgs[0] as
        | {step: number; max: number; tool: string}
        | undefined;
      if (!payload) return;
      if (payload.tool === 'done' || payload.step === 0) {
        setAgentStep(null);
        return;
      }
      setAgentStep({
        step: payload.step,
        max: payload.max,
        tool: payload.tool || 'thinking',
      });
    });
    return () => {
      offToken();
      offDone();
      offDice();
      offAgent();
    };
  }, [
    setDiceCheckRequested,
    setPendingJob,
    setDiceRevealed,
    setLiveDice,
    setAgentStep,
  ]);

  // Recovery codes are no longer player-facing UI. The backend may keep
  // emitting the legacy event for older flows, but the web client must not
  // interrupt gameplay with the retired modal.

  useEffect(() => {
    const off = EventsOn('player:message_rendered', (...evArgs: unknown[]) => {
      const payload = evArgs[0] as
        | {originalText?: string; visibleText?: string; changed?: boolean}
        | undefined;
      if (
        !payload?.changed ||
        typeof payload.originalText !== 'string' ||
        typeof payload.visibleText !== 'string'
      ) {
        return;
      }
      setOptimisticUser(current =>
        current.trim() === payload.originalText!.trim()
          ? payload.visibleText!
          : current,
      );
    });
    return () => off();
  }, [setOptimisticUser]);

  // System events accumulator. Events are standalone timeline items.
  // If an event arrives before the turn's assistant message id is known,
  // system:turn_message_known later supplies only the ordering key.
  useEffect(() => {
    const offEvent = EventsOn('system:event', (...evArgs: unknown[]) => {
      const payload = evArgs[0] as SystemEvent | undefined;
      if (!payload || typeof payload.type !== 'string') return;
      setSystemEvents(prev => {
        // Trim to last 100 to keep DOM bounded.
        const existingIndex = prev.findIndex(event =>
          payload.eventId != null && event.eventId === payload.eventId
            ? true
            : event.id === payload.id,
        );
        if (existingIndex >= 0) {
          const existing = prev[existingIndex];
          if (
            existing &&
            existing.messageId == null &&
            typeof payload.messageId === 'number' &&
            payload.messageId > 0
          ) {
            const next = [...prev];
            next[existingIndex] = {
              ...existing,
              messageId: payload.messageId ?? existing.messageId,
              turnId: payload.turnId ?? existing.turnId,
            };
            return next.sort(compareSystemEvents);
          }
          return prev;
        }
        const next = [...prev, payload].sort(compareSystemEvents);
        return next.length > 100 ? next.slice(next.length - 100) : next;
      });
    });
    const offTurnMessage = EventsOn('system:turn_message_known', (...evArgs: unknown[]) => {
      const payload = evArgs[0] as
        | {turnId?: string | null; messageId?: number | null}
        | undefined;
      if (
        !payload?.turnId ||
        typeof payload.messageId !== 'number' ||
        payload.messageId <= 0
      ) {
        return;
      }
      const messageId = payload.messageId;
      setSystemEvents(prev => {
        let changed = false;
        const next = prev.map(event => {
          if (event.messageId == null && event.turnId === payload.turnId) {
            changed = true;
            return {
              ...event,
              messageId: event.messageId ?? messageId,
            };
          }
          return event;
        });
        return changed ? next.sort(compareSystemEvents) : prev;
      });
    });
    return () => {
      offEvent();
      offTurnMessage();
    };
  }, [setSystemEvents]);
}
