import {useMemo, useState} from 'react';
import {
  polishCharacterDescription,
  polishCharacterHistory,
  synthesizeCharacterSheet,
} from '../../../bridge/character';
import {useTranslation} from '../../../i18n';
import {CreatorChrome} from './CreatorChrome';
import {ThresholdStep} from './steps/ThresholdStep';
import {FormStep} from './steps/FormStep';
import {PastStep} from './steps/PastStep';
import {SynthesisStep} from './steps/SynthesisStep';
import {commitCharacterDraft} from './commitCharacterDraft';
import {useCharacterDraft} from './useCharacterDraft';

interface Props {
  playerId: number;
  baseUrl?: string;
  onComplete: () => void;
  embedded?: boolean;
  commitLabelOverride?: string;
}

type BusyAction =
  | 'description'
  | 'history'
  | 'synthesize'
  | 'commit'
  | null;


function polishedText(data: unknown): string {
  if (data && typeof data === 'object' && 'text' in data) {
    const text = (data as {text?: unknown}).text;
    if (typeof text === 'string') return text;
  }
  return '';
}

/**
 * Greenhaven character creator. Walks the player through five
 * ritual steps:
 *
 *   I. Threshold  — a name on the inside cover
 *   II. Form      — body and manner, with optional AI polish
 *   III. Past     — history that follows them, with optional AI polish

 *   V. Synthesis  — the server writes the card; the player accepts it
 *
 * Each step lives in its own component; this file wires them together,

 * finished draft.
 */
export function CharacterCreator({
  playerId,
  baseUrl = '',
  onComplete,
  embedded = false,
  commitLabelOverride,
}: Props) {
  const {t, setLanguage, language} = useTranslation();
  const {
    draft,
    patchSheet,
    replaceDescription,
    replaceHistory,
    setCard,
    applySynthesis,
    markClassOverridden,
    classes,
    classLoadError,
  } = useCharacterDraft(playerId, baseUrl, language);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState(0);

  const label = (key: string, fallback: string) => {
    const translated = t(key);
    return translated === key ? fallback : translated;
  };

  const steps = useMemo(
    () => [
      {
        index: 0,
        title: label('creator.steps.threshold.title', 'Name'),
        subtitle: label(
          'creator.steps.threshold.subtitle',
          'What name will the world use without ceremony?',
        ),
      },
      {
        index: 1,
        title: label('creator.steps.form.title', 'Form'),
        subtitle: label(
          'creator.steps.form.subtitle',
          'How the body moves through a room.',
        ),
      },
      {
        index: 2,
        title: label('creator.steps.past.title', 'Past'),
        subtitle: label(
          'creator.steps.past.subtitle',
          'What follows you in.',
        ),
      },
      {
        index: 3,
        title: label('creator.steps.synthesis.title', 'Binding'),
        subtitle: label(
          'creator.steps.synthesis.subtitle',
          'The world reads the page and writes the card.',
        ),
      },
    ],
    // label is recreated per render; deps intentionally narrow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [language],
  );

  const nameValid = draft.sheet.name.trim().length > 0;
  const descriptionValid = draft.sheet.description.trim().length >= 8;
  const historyValid = draft.sheet.history.trim().length >= 8;
  const isSynthesisStep = step === steps.length - 1;

  const canNext = (() => {
    switch (step) {
      case 0: return nameValid;
      case 1: return descriptionValid;
      case 2: return historyValid;
      case steps.length - 1: return draft.synthesized;
      default: return false;
    }
  })();

  const runTextAssist = async (kind: 'description' | 'history') => {
    setBusy(kind);
    setError(null);
    try {
      const polish =
        kind === 'description' ? polishCharacterDescription : polishCharacterHistory;
      const data = await polish({
        baseUrl,
        body: {
          name: draft.sheet.name,
          description: draft.sheet.description,
          history: draft.sheet.history,
          language,
        },
      });
      const text = polishedText(data);
      if (!text.trim()) throw new Error(t('creator.error.empty_ai_text'));
      if (kind === 'description') replaceDescription(text);
      else replaceHistory(text);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const buildCard = async () => {
    setBusy('synthesize');
    setError(null);
    try {
      const data = await synthesizeCharacterSheet({
        baseUrl,
        body: {
          // Stable language-neutral semantic ids — see
          // docs/web-ui/frontend-agent-specs/first-run-i18n-hardening.md.
          // Player-facing English question labels were dropped so a
          // non-English player's transcript never carries English prose.
          transcript: [
            {q: 'creator.field.name', a: draft.sheet.name.trim()},
            {q: 'creator.field.description', a: draft.sheet.description.trim()},
            {q: 'creator.field.history', a: draft.sheet.history.trim()},
          ],
          language,
          partialState: {
            language,
            source: 'character_creator_sheet',
            sheet: {
              name: draft.sheet.name.trim(),
              description: draft.sheet.description.trim(),
              history: draft.sheet.history.trim(),
            },
            identity: {name: draft.sheet.name.trim()},
            background: {origin_paragraph: draft.sheet.history.trim()},
          },
        },
      });
      const detected = (data.detected_language ?? data.input_language ?? '')
        .toLowerCase()
        .slice(0, 2);
      if (!language && detected) {
        try {
          await setLanguage(detected);
        } catch {
          /* unknown locale; keep current */
        }
      }
      applySynthesis(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const regenerateBackground = async (
    paragraph: string,
  ): Promise<string | null> => {
    try {
      const data = await polishCharacterHistory({
        baseUrl,
        body: {
          name: draft.card.identity.name ?? draft.sheet.name,
          description: draft.sheet.description,
          history: paragraph,
          language,
        },
      });
      const text = polishedText(data);
      return text.trim() || null;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  };

  const commit = async () => {
    setBusy('commit');
    setError(null);
    try {
      // Aspects/voices feature removed 2026-05-14.
      await commitCharacterDraft(draft, baseUrl);
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const handleNext = () => {
    if (isSynthesisStep) {
      void commit();
      return;
    }
    setStep(prev => Math.min(prev + 1, steps.length - 1));
  };

  const handleBack = () => {
    setError(null);
    setStep(prev => Math.max(prev - 1, 0));
  };

  const renderStep = () => {
    switch (step) {
      case 0:
        return (
          <ThresholdStep
            name={draft.sheet.name}
            onChange={value => patchSheet('name', value)}
            label={label}
          />
        );
      case 1:
        return (
          <FormStep
            description={draft.sheet.description}
            onChange={value => patchSheet('description', value)}
            onPolish={() => void runTextAssist('description')}
            busy={busy != null}
            polishing={busy === 'description'}
            label={label}
          />
        );
      case 2:
        return (
          <PastStep
            history={draft.sheet.history}
            onChange={value => patchSheet('history', value)}
            onPolish={() => void runTextAssist('history')}
            busy={busy != null}
            polishing={busy === 'history'}
            label={label}
          />
        );
      case 3:
        return (
          <SynthesisStep
            draft={draft}
            classes={classes}
            busy={busy != null}
            busyAction={busy}
            hasSynthesis={draft.synthesized}
            setCard={setCard}
            onSynthesize={() => void buildCard()}
            onClassOverride={markClassOverridden}
            onRegenerateBackground={regenerateBackground}
            onCommit={() => void commit()}
            label={label}
            t={t}
            commitLabel={commitLabelOverride}
          />
        );
      default:
        return null;
    }
  };

  // The synthesis step owns its own primary action: first "bind the
  // page", then CardReviewPanel's commit affordance. Hiding chrome's
  // next button here avoids duplicate/disabled nav at the bottom of a
  // long review sheet.
  const hideNext = isSynthesisStep;
  const nextLabel =
    isSynthesisStep && !draft.synthesized
      ? label('creator.synthesis.bind', 'bind the page')
      : label('creator.nav.next', 'continue');

  return (
    <CreatorChrome
      step={step}
      steps={steps}
      canBack={step > 0}
      canNext={canNext}
      busy={busy != null}
      busyLabel={
        busy === 'commit'
          ? label('creator.nav.committing', 'binding…')
          : busy === 'synthesize'
            ? label('creator.nav.binding', 'binding…')
            : undefined
      }
      backLabel={label('creator.nav.back', 'back')}
      nextLabel={nextLabel}
      finalLabel={label('creator.nav.commit', 'step into Greenhaven')}
      onBack={handleBack}
      onNext={handleNext}
      hideNext={hideNext}
      errorMessage={error ?? classLoadError ?? null}
      embedded={embedded}
    >
      {renderStep()}
    </CreatorChrome>
  );
}
