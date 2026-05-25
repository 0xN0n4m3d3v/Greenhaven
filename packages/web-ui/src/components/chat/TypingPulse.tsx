interface Props {
  /** Speaker name — kept for ARIA, not rendered. */
  author: string;
  /** True when the indicator should be visible (pendingJob exists, no text yet). */
  visible: boolean;
  /** Localized verb (e.g. "is composing"). Kept for ARIA only. */
  verb: string;
  /** Optional persona-hue (kept in API for compatibility). */
  hue?: string | null;
  /** Quieter row when queued behind another turn. */
  queued?: boolean;
}

/**
 * Spec 139 v2 — minimal three-dot typing pill pinned bottom-left of the
 * chat scroll. Previously rendered "<author> пишет ..." with an inkwell
 * glyph; operator asked for just the dots. ARIA label still announces
 * the author + verb to screen readers.
 */
export function TypingPulse({author, visible, verb, queued}: Props) {
  if (!visible) return null;
  return (
    <div
      className={`typing-pulse dots-only ${queued ? 'queued' : ''}`}
      role="status"
      aria-live="polite"
      aria-label={`${author} ${verb}`}
    >
      <span className="typing-pulse-dot" />
      <span className="typing-pulse-dot" />
      <span className="typing-pulse-dot" />
    </div>
  );
}
