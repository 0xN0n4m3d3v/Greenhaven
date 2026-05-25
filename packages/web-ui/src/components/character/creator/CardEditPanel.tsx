// Spec 38 §5.4 — Phase 2 single-screen scroll. Every field editable.
// Pre-filled by synthesis. Anatomy / pronouns / gender_expression /
// attractions live in dedicated, top-level sections (NOT folded into
// accordions) per spec §5.4 anti-buried-field rule.
//
// Sub-section order (matches spec §5.4):
//   1. Identity         (IdentitySection)   name + pronouns + gender_expression + race
//   2. Anatomy & body   (AnatomySection)    anatomy + age + attractions
//   3. Appearance       (inline)            build/voice/skin/hair/eyes/distinguishing_marks
//   4. Background       (inline)            origin_paragraph (SynthesisPanel) + motivation/temperament/notable_skills
//   5. Class            (inline)            12-class dropdown + LLM rationale tooltip
//   6. Stats            (inline)            6 numeric inputs + live point-buy budget
//   7. Skills           (inline)            class-restricted checkboxes + per-pick rationale

import {useMemo, useState, type Dispatch, type SetStateAction} from 'react';
import type {Background, ClassRow, Physical, Stats} from '../wizardTypes';
import {AnatomySection} from './AnatomySection';
import {IdentitySection} from './IdentitySection';
import {SynthesisPanel} from './SynthesisPanel';
import type {CharacterCardState, IdentityPlus} from './types';

interface Props {
  state: CharacterCardState;
  setState: Dispatch<SetStateAction<CharacterCardState>>;
  classes: ClassRow[];
  busy: boolean;
  onCommit: () => void;
  onClassOverride: () => void;
  onRegenerateBackground?: (paragraph: string) => Promise<string | null>;
  t: (key: string) => string;
  commitLabel: string;
  titleLabel: string;
}

const STAT_ORDER: Array<keyof Stats> = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'];

const POINT_BUY_COSTS: Record<number, number> = {
  8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9,
};
const POINT_BUY_BUDGET = 27;

function pointBuySpend(stats: Stats): number {
  let sum = 0;
  for (const v of Object.values(stats)) {
    const c = POINT_BUY_COSTS[v];
    if (c !== undefined) sum += c;
  }
  return sum;
}

// Server (POST /character/:id/stats) only rejects OVER-budget, allows
// under-budget. Phase 2 mirrors that contract so the model has freedom
// to give a "weaker" hero (24/27) deliberately — the player can spend
// the slack or accept it. Over-budget remains a hard block.
function pointBuyAllowed(stats: Stats): boolean {
  for (const v of Object.values(stats)) {
    if (typeof v !== 'number' || v < 8 || v > 15) return false;
    if (POINT_BUY_COSTS[v] === undefined) return false;
  }
  return pointBuySpend(stats) <= POINT_BUY_BUDGET;
}

const PHYSICAL_FIELDS: Array<{key: keyof Physical; placeholder: string}> = [
  {key: 'build', placeholder: '1.78m, athletic'},
  {key: 'voice', placeholder: 'low, melodic'},
  {key: 'skin', placeholder: 'lavender, smooth'},
  {key: 'hair', placeholder: 'black, braided'},
  {key: 'eyes', placeholder: 'amber, slit pupils'},
  {key: 'distinguishing_marks', placeholder: 'curling horns, brand on left shoulder'},
];

export function CardEditPanel({
  state,
  setState,
  classes,
  busy,
  onCommit,
  onClassOverride,
  onRegenerateBackground,
  t,
  commitLabel,
  titleLabel,
}: Props) {
  const [skillDraft, setSkillDraft] = useState('');

  const patchIdentity = (p: Partial<IdentityPlus>) =>
    setState(prev => ({...prev, identity: {...prev.identity, ...p}}));
  const patchPhysical = (p: Partial<Physical>) =>
    setState(prev => ({...prev, physical: {...prev.physical, ...p}}));
  const patchBackground = (p: Partial<Background>) =>
    setState(prev => ({...prev, background: {...prev.background, ...p}}));

  // Default to D&D standard array (15/14/13/12/10/8 = exactly 27 cost)
  // when synthesis didn't return stats (short transcript edge case).
  // Without this the player would see an over-budget card and a
  // disabled commit button on first paint.
  const DEFAULT_STATS: Stats = {STR: 13, DEX: 14, CON: 12, INT: 10, WIS: 15, CHA: 8};
  const stats: Stats = state.stats ?? DEFAULT_STATS;
  const setStat = (k: keyof Stats, v: number) =>
    setState(prev => ({
      ...prev,
      stats: {...(prev.stats ?? stats), [k]: v},
    }));

  const spend = pointBuySpend(stats);
  const allowed = pointBuyAllowed(stats);
  const slack = POINT_BUY_BUDGET - spend;
  const budgetState: 'over' | 'balanced' | 'unspent' =
    spend > POINT_BUY_BUDGET
      ? 'over'
      : spend === POINT_BUY_BUDGET
        ? 'balanced'
        : 'unspent';

  const currentClass = useMemo(
    () => classes.find(c => c.id === state.starting_class_id) ?? null,
    [classes, state.starting_class_id],
  );
  const allowedSkills = currentClass?.profile?.skill_choices?.from ?? [];
  const skillPickCount = currentClass?.profile?.skill_choices?.pick ?? 0;
  const skillsComplete = skillPickCount === 0 || state.skills.length === skillPickCount;

  const toggleSkill = (s: string) => {
    setState(prev => {
      const has = prev.skills.includes(s);
      if (has) return {...prev, skills: prev.skills.filter(x => x !== s)};
      if (prev.skills.length >= skillPickCount) return prev;
      return {...prev, skills: [...prev.skills, s]};
    });
  };

  const notable = state.background.notable_skills ?? [];
  const addNotable = () => {
    const v = skillDraft.trim();
    if (!v) return;
    if (notable.includes(v)) return;
    patchBackground({notable_skills: [...notable, v]});
    setSkillDraft('');
  };
  const removeNotable = (s: string) =>
    patchBackground({notable_skills: notable.filter(x => x !== s)});

  const heroName = (state.identity.name ?? '').trim();
  const heroPronouns = (state.identity.pronouns ?? '').trim();
  const heroRace = (state.identity.race ?? '').trim();
  const heroAge = (state.identity.age ?? '').toString().trim();

  return (
    <section className="examiner-edit-panel" aria-label="Phase 2 character review">
      <header className="creator-hero-band">
        <p className="creator-hero-eyebrow">{titleLabel}</p>
        <h1 className="creator-hero-name">
          {heroName || <span className="creator-hero-name-placeholder">unnamed</span>}
        </h1>
        <p className="creator-hero-meta">
          {[heroPronouns, heroRace, heroAge && `age ${heroAge}`]
            .filter(Boolean)
            .join(' · ') || <span className="creator-hero-meta-empty">— pending —</span>}
        </p>
        <div className="creator-hero-divider" aria-hidden>
          <span className="ornament" aria-hidden>❦</span>
        </div>
      </header>

      <IdentitySection identity={state.identity} patch={patchIdentity} t={t} />
      <AnatomySection identity={state.identity} patch={patchIdentity} t={t} />

      <fieldset className="examiner-section examiner-section-physical">
        <legend>{t('examiner.section.physical')}</legend>
        {PHYSICAL_FIELDS.map(f => (
          <label className="examiner-field" key={f.key}>
            <span>{f.key.replace('_', ' ')}</span>
            <input
              type="text"
              value={(state.physical[f.key] as string) ?? ''}
              onChange={e => patchPhysical({[f.key]: e.target.value} as Partial<Physical>)}
              placeholder={f.placeholder}
              maxLength={400}
            />
          </label>
        ))}
      </fieldset>

      <fieldset className="examiner-section examiner-section-background">
        <legend>{t('examiner.section.background')}</legend>
        <label className="examiner-field examiner-field-prominent">
          <span>origin paragraph</span>
          <SynthesisPanel
            paragraph={state.background.origin_paragraph ?? ''}
            onParagraphChange={p => patchBackground({origin_paragraph: p})}
            onRegenerate={() =>
              onRegenerateBackground
                ? onRegenerateBackground(state.background.origin_paragraph ?? '')
                : Promise.resolve(null)
            }
            busy={busy}
          />
        </label>
        <label className="examiner-field">
          <span>motivation</span>
          <input
            type="text"
            value={state.background.motivation ?? ''}
            onChange={e => patchBackground({motivation: e.target.value})}
            maxLength={200}
          />
        </label>
        <label className="examiner-field">
          <span>temperament</span>
          <input
            type="text"
            value={state.background.temperament ?? ''}
            onChange={e => patchBackground({temperament: e.target.value})}
            maxLength={160}
          />
        </label>
        <label className="examiner-field">
          <span>notable skills</span>
          <div className="examiner-chips">
            {notable.map(s => (
              <button
                type="button"
                key={s}
                className="examiner-chip"
                onClick={() => removeNotable(s)}
                title="Remove"
              >
                {s} ×
              </button>
            ))}
            <input
              type="text"
              value={skillDraft}
              onChange={e => setSkillDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addNotable();
                }
              }}
              placeholder="add skill, press Enter"
            />
          </div>
        </label>
      </fieldset>

      <fieldset className="examiner-section examiner-section-class">
        <legend>{t('examiner.section.class')}</legend>
        {state.class_pick_rationale && (
          <p className="examiner-hint">{state.class_pick_rationale}</p>
        )}
        <select
          value={state.starting_class_id ?? ''}
          onChange={e => {
            const v = e.target.value === '' ? null : Number(e.target.value);
            setState(prev => ({...prev, starting_class_id: v, skills: []}));
            onClassOverride();
          }}
        >
          <option value="">— choose —</option>
          {classes.map(c => (
            <option key={c.id} value={c.id}>
              {c.display_name}
              {c.summary ? ` · ${c.summary.slice(0, 60)}` : ''}
            </option>
          ))}
        </select>
      </fieldset>

      <fieldset className="examiner-section examiner-section-stats">
        <legend>{t('examiner.section.stats')}</legend>

        <div
          className={`stat-budget budget-${budgetState}`}
          role="meter"
          aria-valuemin={0}
          aria-valuemax={POINT_BUY_BUDGET}
          aria-valuenow={Math.min(spend, POINT_BUY_BUDGET)}
          aria-label={`Point-buy: ${spend} of ${POINT_BUY_BUDGET}`}
        >
          <div className="stat-budget-head">
            <span className="stat-budget-label">point-buy</span>
            <span className="stat-budget-count">
              <strong>{spend}</strong>
              <span className="stat-budget-slash">/</span>
              <span>{POINT_BUY_BUDGET}</span>
            </span>
            <span className="stat-budget-state">
              {budgetState === 'balanced' && 'balanced'}
              {budgetState === 'unspent' && `${slack} unspent`}
              {budgetState === 'over' && `${spend - POINT_BUY_BUDGET} over`}
            </span>
          </div>
          <div className="stat-budget-track">
            {Array.from({length: POINT_BUY_BUDGET}, (_, i) => {
              const filled = i < spend;
              const overflow = i >= POINT_BUY_BUDGET;
              return (
                <span
                  key={i}
                  className={`stat-budget-pip ${filled ? 'filled' : ''} ${overflow ? 'overflow' : ''}`}
                  aria-hidden
                />
              );
            })}
            {spend > POINT_BUY_BUDGET && (
              Array.from({length: spend - POINT_BUY_BUDGET}, (_, i) => (
                <span
                  key={`over-${i}`}
                  className="stat-budget-pip filled overflow"
                  aria-hidden
                />
              ))
            )}
          </div>
          {budgetState === 'over' && (
            <p className="stat-budget-warn">
              over budget — pull a stat down before signing the page.
            </p>
          )}
          {budgetState === 'unspent' && slack > 0 && (
            <p className="stat-budget-aside">
              you can spend the remaining {slack} point{slack === 1 ? '' : 's'} or accept the slack.
            </p>
          )}
        </div>

        <div className="stat-grid">
          {STAT_ORDER.map(k => {
            const value = stats[k];
            const cost = POINT_BUY_COSTS[value] ?? 0;
            return (
              <div className="stat-cell" key={k}>
                <div className="stat-cell-name">{k}</div>
                <div className="stat-cell-stepper">
                  <button
                    type="button"
                    className="stat-step"
                    aria-label={`decrease ${k}`}
                    disabled={value <= 8}
                    onClick={() => setStat(k, Math.max(8, value - 1))}
                  >
                    ◀
                  </button>
                  <input
                    type="number"
                    className="stat-cell-value"
                    min={8}
                    max={15}
                    value={value}
                    onChange={e => setStat(k, Number(e.target.value))}
                  />
                  <button
                    type="button"
                    className="stat-step"
                    aria-label={`increase ${k}`}
                    disabled={value >= 15}
                    onClick={() => setStat(k, Math.min(15, value + 1))}
                  >
                    ▶
                  </button>
                </div>
                <div className="stat-cell-cost" title="point-buy cost">
                  {cost} pt{cost === 1 ? '' : 's'}
                </div>
              </div>
            );
          })}
        </div>
      </fieldset>

      <fieldset className="examiner-section examiner-section-skills">
        <legend>
          {t('examiner.section.skills')}
          {skillPickCount > 0 && (
            <span className="legend-counter">
              {state.skills.length} / {skillPickCount}
            </span>
          )}
        </legend>
        {allowedSkills.length === 0 ? (
          <p className="examiner-hint">Pick a class first — your skills depend on it.</p>
        ) : (
          <div className="skill-sigil-grid">
            {allowedSkills.map(s => {
              const checked = state.skills.includes(s);
              const rationale = state.skill_picks_rationale?.[s];
              const locked = !checked && state.skills.length >= skillPickCount;
              return (
                <button
                  key={s}
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  aria-disabled={locked}
                  className={`skill-sigil ${checked ? 'chosen' : ''} ${locked ? 'locked' : ''}`}
                  title={rationale ?? ''}
                  onClick={() => {
                    if (!locked || checked) toggleSkill(s);
                  }}
                  disabled={locked}
                >
                  <span className="skill-sigil-glyph" aria-hidden>
                    {checked ? '✦' : '◇'}
                  </span>
                  <span className="skill-sigil-name">{s}</span>
                  {rationale && (
                    <span className="skill-sigil-rationale" aria-hidden>
                      {rationale}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
        {skillPickCount > 0 && !skillsComplete && (
          <p className="examiner-hint warn">
            Choose {skillPickCount - state.skills.length} more skill
            {skillPickCount - state.skills.length === 1 ? '' : 's'}.
          </p>
        )}
      </fieldset>

      <footer className="examiner-edit-footer creator-sign-row">
        <p className="creator-sign-flavour">
          When the ink dries, the world closes around you.
        </p>
        <button
          type="button"
          className="examiner-primary creator-sign-button"
          disabled={
            busy ||
            !allowed ||
            state.starting_class_id == null ||
            !skillsComplete ||
            (state.identity.name ?? '').trim().length === 0
          }
          onClick={onCommit}
        >
          <span className="creator-sign-seal" aria-hidden>❧</span>
          <span>{busy ? '…' : commitLabel}</span>
        </button>
      </footer>
    </section>
  );
}
