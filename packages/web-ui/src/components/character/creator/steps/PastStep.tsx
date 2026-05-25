import {ScrollText} from 'lucide-react';

interface Props {
  history: string;
  onChange: (next: string) => void;
  onPolish: () => void;
  busy: boolean;
  polishing: boolean;
  label: (key: string, fallback: string) => string;
}

/**
 * Step III — history. The biography, the debts, the shame.
 * Mirrors FormStep visually but the prompt is darker and the polish
 * button is "bind the binding" — making it sound less like editing
 * and more like committing a fact about the world.
 */
export function PastStep({
  history,
  onChange,
  onPolish,
  busy,
  polishing,
  label,
}: Props) {
  return (
    <div className="creator-step past">
      <p className="creator-step-prompt">
        {label(
          'creator.past.prompt',
          'What did the world do to you, before you came here?',
        )}
      </p>

      <div className="creator-textfield">
        <textarea
          value={history}
          onChange={e => onChange(e.target.value)}
          maxLength={6000}
          rows={9}
          placeholder={label(
            'creator.past.placeholder',
            'A debt that follows. A house that won’t open. A name you no longer use. Why Greenhaven, and why now.',
          )}
        />
        <div className="creator-textfield-actions">
          <button
            type="button"
            className="creator-tool"
            disabled={busy || history.trim().length < 8}
            onClick={onPolish}
          >
            <ScrollText size={14} aria-hidden />
            {polishing
              ? label('creator.past.binding', 'binding the binding…')
              : history.trim()
                ? label('creator.past.polish',   'bind the binding')
                : label('creator.past.generate', 'find the binding')}
          </button>
          <span className="creator-textfield-counter">
            {history.length}/6000
          </span>
        </div>
      </div>

      <p className="creator-step-hint">
        {label(
          'creator.past.hint',
          'A page of past is enough. The rest will appear in play, whether you want it to or not.',
        )}
      </p>
    </div>
  );
}
