import {Sparkles} from 'lucide-react';
import type {ClassRow} from '../../wizardTypes';
import {CardReviewPanel} from '../CardReviewPanel';
import type {CharacterDraft, CharacterCardState} from '../types';

interface Props {
  draft: CharacterDraft;
  classes: ClassRow[];
  busy: boolean;
  busyAction: string | null;
  hasSynthesis: boolean;
  setCard: (
    updater:
      | CharacterCardState
      | ((prev: CharacterCardState) => CharacterCardState),
  ) => void;
  onSynthesize: () => void;
  onClassOverride: () => void;
  onRegenerateBackground: (paragraph: string) => Promise<string | null>;
  onCommit: () => void;
  label: (key: string, fallback: string) => string;
  t: (key: string, vars?: Record<string, string | number>) => string;
  commitLabel?: string;
}

/**
 * Step V — synthesis. The first half is a single ceremonial action:
 * "Bind the page". When the player presses it, the server reads the
 * sheet + history and writes a full card. The lower half then reveals
 * the existing CardReviewPanel for any final adjustments and the
 * "Step into Greenhaven" commit.
 */
export function SynthesisStep({
  draft,
  classes,
  busy,
  busyAction,
  hasSynthesis,
  setCard,
  onSynthesize,
  onClassOverride,
  onRegenerateBackground,
  onCommit,
  label,
  t,
  commitLabel,
}: Props) {
  if (!hasSynthesis) {
    return (
      <div className="creator-step synthesis intro">
        <p className="creator-step-prompt">
          {label(
            'creator.synthesis.prompt',
            'The page is full enough. Read it once, then bind it — the world will write the rest.',
          )}
        </p>
        <button
          type="button"
          className="creator-bind"
          onClick={onSynthesize}
          disabled={busy}
        >
          <Sparkles size={18} aria-hidden />
          {busy && busyAction === 'synthesize'
            ? label('creator.synthesis.binding', 'binding the page…')
            : label('creator.synthesis.bind',    'bind the page')}
        </button>
        <p className="creator-step-hint">
          {label(
            'creator.synthesis.hint',
            'A class, a starting layout, a few skills. None of it is final — you can change it on the next pass.',
          )}
        </p>
      </div>
    );
  }

  return (
    <div className="creator-step synthesis review">
      <p className="creator-step-prompt">
        {label(
          'creator.synthesis.review_prompt',
          'Read the card the world wrote for you. Adjust what no longer feels true.',
        )}
      </p>
      <div className="creator-review-frame">
        <CardReviewPanel
          state={draft.card}
          setState={setCard}
          classes={classes}
          busy={busy}
          onCommit={onCommit}
          onClassOverride={onClassOverride}
          onRegenerateBackground={onRegenerateBackground}
          t={t}
          titleLabel={label(
            'creator.synthesis.review_title',
            'The card the world wrote',
          )}
          commitLabel={
            commitLabel ??
            label('creator.synthesis.commit', 'step into Greenhaven')
          }
        />
      </div>
    </div>
  );
}
