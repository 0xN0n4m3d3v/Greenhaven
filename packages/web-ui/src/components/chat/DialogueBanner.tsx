// Dialogue banner — shows above the message flow when the player is
// currently in a dialogue with an NPC OR when there's a recent partner
// they can resume with. Extracted from App.tsx (spec 29 decomposition).

interface PartnerSummary {
  id: number;
  name: string;
}

interface Props {
  active: PartnerSummary | null;
  last: PartnerSummary | null;
  onResume: (id: number, name: string) => void;
  t: (key: string) => string;
}

export function DialogueBanner({active, last, onResume, t}: Props) {
  if (active) {
    return (
      <div className="dialogue-banner active">
        <span>
          {t('ui.dialogue.in_dialogue_with')} <strong>{active.name}</strong>
        </span>
      </div>
    );
  }
  if (last) {
    return (
      <div className="dialogue-banner idle">
        <span>
          {t('ui.dialogue.last_partner')} <strong>{last.name}</strong>
        </span>
        <button type="button" onClick={() => onResume(last.id, last.name)}>
          {t('ui.dialogue.resume')}
        </button>
      </div>
    );
  }
  return null;
}
