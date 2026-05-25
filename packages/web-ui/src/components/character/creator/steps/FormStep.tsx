import {Feather} from 'lucide-react';

interface Props {
  description: string;
  onChange: (next: string) => void;
  onPolish: () => void;
  busy: boolean;
  polishing: boolean;
  label: (key: string, fallback: string) => string;
}

/**
 * Step II — description. The body, the voice, the way they walk.
 * The textarea is a long sepia field with a quill icon next to a
 * "Polish ink" assist that asks the server for a more elegant
 * rendering of what was written.
 */
export function FormStep({
  description,
  onChange,
  onPolish,
  busy,
  polishing,
  label,
}: Props) {
  return (
    <div className="creator-step form">
      <p className="creator-step-prompt">
        {label(
          'creator.form.prompt',
          'Body, manner, voice. Not what they call you. What they would notice across a room.',
        )}
      </p>

      <div className="creator-textfield">
        <textarea
          value={description}
          onChange={e => onChange(e.target.value)}
          maxLength={6000}
          rows={9}
          placeholder={label(
            'creator.form.placeholder',
            'Pale hands. A coat the color of damp slate. Speaks slow when sober. Blinks too often when not.',
          )}
        />
        <div className="creator-textfield-actions">
          <button
            type="button"
            className="creator-tool"
            disabled={busy || description.trim().length < 8}
            onClick={onPolish}
          >
            <Feather size={14} aria-hidden />
            {polishing
              ? label('creator.form.polishing', 'polishing the ink…')
              : label('creator.form.polish',    'polish the ink')}
          </button>
          <span className="creator-textfield-counter">
            {description.length}/6000
          </span>
        </div>
      </div>

      <p className="creator-step-hint">
        {label(
          'creator.form.hint',
          'Long passages are welcome. The world reads them quietly.',
        )}
      </p>
    </div>
  );
}
