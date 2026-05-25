import {ScrollText, Sparkles, UserRound, WandSparkles} from 'lucide-react';
import type {CharacterSheet} from './types';

interface Props {
  sheet: CharacterSheet;
  busy: boolean;
  activeAction: string | null;
  canBuild: boolean;
  onFieldChange: (field: keyof Pick<CharacterSheet, 'name' | 'description' | 'history'>, value: string) => void;
  onPolishDescription: () => void;
  onPolishHistory: () => void;
  onBuildCard: () => void;
  label: (key: string, fallback: string) => string;
}

export function FullSheetPanel({
  sheet,
  busy,
  activeAction,
  canBuild,
  onFieldChange,
  onPolishDescription,
  onPolishHistory,
  onBuildCard,
  label,
}: Props) {
  return (
    <section className="creator-sheet" aria-label="Character concept sheet">
      <header className="creator-sheet-header">
        <div>
          <p className="creator-kicker">{label('creator.kicker', 'Character creator')}</p>
          <h1>{label('creator.title', 'Create your character')}</h1>
        </div>
        <button
          type="button"
          className="creator-primary"
          disabled={busy || !canBuild}
          onClick={onBuildCard}
        >
          <Sparkles size={17} aria-hidden />
          {activeAction === 'synthesize'
            ? label('creator.action.building', 'Building...')
            : label('creator.action.build_card', 'Build character card')}
        </button>
      </header>

      <label className="creator-field creator-field-name">
        <span>
          <UserRound size={16} aria-hidden />
          {label('creator.field.name', 'Character name')}
        </span>
        <input
          type="text"
          value={sheet.name}
          maxLength={120}
          onChange={e => onFieldChange('name', e.target.value)}
          placeholder={label('creator.placeholder.name', 'Name used by NPCs')}
        />
      </label>

      <label className="creator-field creator-field-large">
        <span>
          <WandSparkles size={16} aria-hidden />
          {label('creator.field.description', 'Description')}
        </span>
        <textarea
          value={sheet.description}
          maxLength={6000}
          rows={8}
          onChange={e => onFieldChange('description', e.target.value)}
          placeholder={label(
            'creator.placeholder.description',
            'Who they are, what they are, appearance, anatomy, orientation, clothes, manners, voice.',
          )}
        />
        <div className="creator-field-actions">
          <button
            type="button"
            className="creator-tool"
            disabled={busy || sheet.description.trim().length < 8}
            onClick={onPolishDescription}
          >
            <WandSparkles size={15} aria-hidden />
            {activeAction === 'description'
              ? label('creator.action.polishing', 'Polishing...')
              : label('creator.action.polish_description', 'Polish description')}
          </button>
          <span>{sheet.description.length}/6000</span>
        </div>
      </label>

      <label className="creator-field creator-field-large">
        <span>
          <ScrollText size={16} aria-hidden />
          {label('creator.field.history', 'History')}
        </span>
        <textarea
          value={sheet.history}
          maxLength={6000}
          rows={7}
          onChange={e => onFieldChange('history', e.target.value)}
          placeholder={label(
            'creator.placeholder.history',
            'Biography, origin, debts, motives, rumors, shame, pride, and why Greenhaven matters now.',
          )}
        />
        <div className="creator-field-actions">
          <button
            type="button"
            className="creator-tool"
            disabled={busy || sheet.description.trim().length < 8}
            onClick={onPolishHistory}
          >
            <Sparkles size={15} aria-hidden />
            {activeAction === 'history'
              ? label('creator.action.writing', 'Writing...')
              : sheet.history.trim()
                ? label('creator.action.polish_history', 'Polish history')
                : label('creator.action.generate_history', 'Generate history')}
          </button>
          <span>{sheet.history.length}/6000</span>
        </div>
      </label>
    </section>
  );
}
