import {CardEditPanel} from './CardEditPanel';
import type {ClassRow} from '../wizardTypes';
import type {CharacterCardState} from './types';
import type {Dispatch, SetStateAction} from 'react';

interface Props {
  state: CharacterCardState;
  setState: Dispatch<SetStateAction<CharacterCardState>>;
  classes: ClassRow[];
  busy: boolean;
  onCommit: () => void;
  onClassOverride: () => void;
  onRegenerateBackground: (paragraph: string) => Promise<string | null>;
  t: (key: string) => string;
  titleLabel: string;
  commitLabel: string;
}

export function CardReviewPanel(props: Props) {
  return <CardEditPanel {...props} />;
}
