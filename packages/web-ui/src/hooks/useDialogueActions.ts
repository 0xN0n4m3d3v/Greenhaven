import {useCallback} from 'react';
import type {Dispatch, SetStateAction} from 'react';
import type {BubbleMenuState} from '../components/chat/BubbleMenu';
import type {MentionTarget} from '../types/app';
import {
  SignOut,
  StartDialogue,
} from '../bridge/platform';

type DialoguePartner = {id: number; name: string};

type UseDialogueActionsArgs = {
  setDialoguePartner: Dispatch<SetStateAction<DialoguePartner | null>>;
  setLastDialoguePartner: Dispatch<SetStateAction<DialoguePartner | null>>;
  setBubbleMenu: Dispatch<SetStateAction<BubbleMenuState | null>>;
  setError: Dispatch<SetStateAction<string>>;
  insertMention: (target: MentionTarget) => void;
};

export function useDialogueActions({
  setDialoguePartner,
  setLastDialoguePartner,
  setBubbleMenu,
  setError,
  insertMention,
}: UseDialogueActionsArgs): {
  handleSignOut: () => void;
  handleStartDialogue: (npcId: number, npcName: string) => Promise<void>;
} {
  const handleSignOut = useCallback(() => {
    SignOut();
    window.location.reload();
  }, []);

  const handleStartDialogue = useCallback(
    async (npcId: number, npcName: string) => {
      try {
        await StartDialogue(npcId);
        const next = {id: npcId, name: npcName};
        setDialoguePartner(next);
        setLastDialoguePartner(next);
        insertMention({id: npcId, name: npcName, type: 'person'});
      } catch (err) {
        console.error('StartDialogue failed', err);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBubbleMenu(null);
      }
    },
    [
      insertMention,
      setBubbleMenu,
      setDialoguePartner,
      setError,
      setLastDialoguePartner,
    ],
  );

  return {handleSignOut, handleStartDialogue};
}
