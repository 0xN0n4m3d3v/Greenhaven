// Spec 38 §5.4 — Phase 2 Anatomy sub-section.
//
// **Anti-buried-field rule** (spec §5.4 + §11 gotcha #5): anatomy /
// attractions live HERE, not folded into Identity, because they're
// the most NPC-visible identity fields. Synthesis must now prefill
// them; if a player clears them manually, commit restores a safe
// character-sheet-derived value instead of saving a blank profile.

import type {IdentityPlus} from './types';

interface Props {
  identity: IdentityPlus;
  patch: (p: Partial<IdentityPlus>) => void;
  t: (key: string) => string;
}

export function AnatomySection({identity, patch, t}: Props) {
  const anatomyEmpty =
    identity.anatomy == null || identity.anatomy.trim() === '';
  const attractionsEmpty =
    identity.attractions == null || identity.attractions.trim() === '';
  return (
    <fieldset className="examiner-section examiner-section-anatomy">
      <legend>{t('examiner.section.anatomy')}</legend>
      <label className="examiner-field examiner-field-prominent">
        <span>{t('examiner.field.anatomy')}</span>
        <textarea
          value={identity.anatomy ?? ''}
          maxLength={400}
          rows={3}
          onChange={e => patch({anatomy: e.target.value})}
          placeholder={
            anatomyEmpty ? t('examiner.empty_pending') : ''
          }
        />
        <p className="examiner-hint">{t('examiner.field.anatomy_hint')}</p>
      </label>
      <label className="examiner-field">
        <span>{t('examiner.field.age')}</span>
        <input
          type="number"
          min={18}
          max={10000}
          value={identity.age ?? ''}
          onChange={e => {
            const v = e.target.value === '' ? undefined : Number(e.target.value);
            patch({age: typeof v === 'number' && Number.isFinite(v) ? v : undefined});
          }}
        />
      </label>
      <label className="examiner-field examiner-field-prominent">
        <span>{t('examiner.field.attractions')}</span>
        <textarea
          value={identity.attractions ?? ''}
          maxLength={200}
          rows={2}
          onChange={e => patch({attractions: e.target.value})}
          placeholder={
            attractionsEmpty ? t('examiner.empty_pending') : ''
          }
        />
      </label>
    </fieldset>
  );
}
