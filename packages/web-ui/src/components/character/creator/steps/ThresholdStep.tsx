interface Props {
  name: string;
  onChange: (next: string) => void;
  label: (key: string, fallback: string) => string;
}

/**
 * Step I — name. The single most ceremonial moment in the creator:
 * a wide field on parchment with caveat handwriting, like signing
 * the inside cover of a notebook.
 */
export function ThresholdStep({name, onChange, label}: Props) {
  return (
    <div className="creator-step threshold">
      <p className="creator-step-prompt">
        {label(
          'creator.threshold.prompt',
          'Inscribe it on the inside cover. The world will use it without ceremony.',
        )}
      </p>
      <label className="creator-name-field">
        <input
          type="text"
          value={name}
          maxLength={120}
          autoFocus
          spellCheck="false"
          autoComplete="off"
          onChange={e => onChange(e.target.value)}
          placeholder={label('creator.threshold.placeholder', 'a name…')}
        />
        <span className="creator-name-underline" aria-hidden />
      </label>
      <p className="creator-step-hint">
        {label(
          'creator.threshold.hint',
          'You can write a single name, two names, a title, or a fragment of one.',
        )}
      </p>
    </div>
  );
}
