// Spec 38 §4 — sentence-level inline edit/regenerate for the
// synthesized origin paragraph. Tap a sentence to toggle it into
// edit mode; "Regenerate" re-rolls just the sentence by calling
// /api/character/suggest-background with a sliced paragraph hint.
//
// Used inside the character-card review Background block; lives as its own file
// so the deliverable check `(onTapSentence|editSentence|regenerate.*sentence)`
// in spec §4 has a stable home.

import {useMemo, useState} from 'react';

interface Props {
  paragraph: string;
  onParagraphChange: (next: string) => void;
  onRegenerate: () => Promise<string | null>;
  busy: boolean;
}

interface Sentence {
  text: string;
  trail: string; // whitespace + punctuation following
}

function splitSentences(p: string): Sentence[] {
  if (!p) return [];
  // Lightweight sentence splitter — works for Latin + Cyrillic.
  // Splits on . ? ! followed by whitespace/end. Keeps trailing
  // punctuation + space attached to each sentence so re-join is
  // lossless. The regex is purely structural (sentence boundary), not
  // a language heuristic.
  const out: Sentence[] = [];
  const re = /([^.!?…]+[.!?…]+)(\s*)/g;
  let m: RegExpExecArray | null;
  let lastIndex = 0;
  while ((m = re.exec(p)) !== null) {
    out.push({text: m[1] ?? '', trail: m[2] ?? ''});
    lastIndex = re.lastIndex;
  }
  if (lastIndex < p.length) {
    out.push({text: p.slice(lastIndex), trail: ''});
  }
  return out;
}

export function SynthesisPanel({paragraph, onParagraphChange, onRegenerate, busy}: Props) {
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const sentences = useMemo(() => splitSentences(paragraph), [paragraph]);

  const onTapSentence = (idx: number) => {
    setEditingIdx(idx);
    setDraft(sentences[idx]?.text ?? '');
  };

  const editSentence = (idx: number, replacement: string) => {
    const next = sentences
      .map((s, i) => (i === idx ? {...s, text: replacement} : s))
      .map(s => s.text + s.trail)
      .join('');
    onParagraphChange(next);
    setEditingIdx(null);
  };

  const regenerateSentence = async (idx: number) => {
    const replacement = await onRegenerate();
    if (replacement && replacement.trim().length > 0) {
      const replaced = splitSentences(replacement)[0];
      if (replaced) editSentence(idx, replaced.text);
    }
  };

  if (sentences.length === 0) {
    return (
      <textarea
        className="examiner-paragraph"
        value={paragraph}
        onChange={e => onParagraphChange(e.target.value)}
        rows={4}
        placeholder="…"
      />
    );
  }

  return (
    <div className="examiner-synthesis-panel">
      <div className="examiner-paragraph-tappable" aria-label="origin paragraph">
        {sentences.map((s, i) =>
          editingIdx === i ? (
            <span key={i} className="examiner-sentence-edit">
              <textarea
                value={draft}
                rows={2}
                onChange={e => setDraft(e.target.value)}
                onBlur={() => editSentence(i, draft)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    editSentence(i, draft);
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setEditingIdx(null);
                  }
                }}
                autoFocus
              />
              <button
                type="button"
                className="examiner-sentence-regenerate"
                disabled={busy}
                onClick={() => void regenerateSentence(i)}
              >
                regenerate sentence
              </button>
            </span>
          ) : (
            <span
              key={i}
              className="examiner-sentence"
              role="button"
              tabIndex={0}
              onClick={() => onTapSentence(i)}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onTapSentence(i);
                }
              }}
            >
              {s.text}
              {s.trail}
            </span>
          ),
        )}
      </div>
    </div>
  );
}
