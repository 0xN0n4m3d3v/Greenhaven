// Spec 38 §5.4 — Phase 2 Identity sub-section.
// Surfaces: name, pronouns (with presets), gender_expression, race.
// Not anatomy / attractions — those live in AnatomySection so they
// cannot be missed. Pronouns + gender_expression are kept SEPARATE
// (per spec §11 gotcha #10) so a player can have he/him + feminine
// gender expression independently.

import type {IdentityPlus} from './types';

interface Props {
  identity: IdentityPlus;
  patch: (p: Partial<IdentityPlus>) => void;
  t: (key: string) => string;
}

const PRONOUN_PRESETS = ['she/her', 'he/him', 'they/them', 'it/its'];

export function IdentitySection({identity, patch, t}: Props) {
  return (
    <fieldset className="examiner-section examiner-section-identity">
      <legend>{t('examiner.section.identity')}</legend>
      <label className="examiner-field">
        <span>{t('examiner.field.name')}</span>
        <input
          type="text"
          value={identity.name ?? ''}
          maxLength={120}
          onChange={e => patch({name: e.target.value})}
          placeholder="Vey · Веска · …"
        />
      </label>
      <label className="examiner-field">
        <span>{t('examiner.field.pronouns')}</span>
        <input
          type="text"
          value={identity.pronouns ?? ''}
          maxLength={40}
          onChange={e => patch({pronouns: e.target.value})}
          placeholder="she/her"
        />
        <div className="examiner-presets">
          {PRONOUN_PRESETS.map(p => (
            <button
              key={p}
              type="button"
              className={identity.pronouns === p ? 'active' : ''}
              onClick={() => patch({pronouns: p})}
            >
              {p}
            </button>
          ))}
        </div>
      </label>
      <label className="examiner-field">
        <span>{t('examiner.field.gender_expression')}</span>
        <input
          type="text"
          value={identity.gender_expression ?? ''}
          maxLength={120}
          onChange={e => patch({gender_expression: e.target.value})}
          placeholder="feminine · masculine · androgynous · …"
        />
      </label>
      <label className="examiner-field">
        <span>{t('examiner.field.race')}</span>
        <input
          type="text"
          value={identity.race ?? ''}
          maxLength={60}
          onChange={e => patch({race: e.target.value})}
          placeholder="Tiefling · Human · Goblin · …"
        />
      </label>
    </fieldset>
  );
}
