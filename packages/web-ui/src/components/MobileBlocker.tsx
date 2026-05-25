import {useEffect, useState} from 'react';

const MIN_WIDTH = 1024;

export function MobileBlocker() {
  const [tooNarrow, setTooNarrow] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.innerWidth < MIN_WIDTH;
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = () => setTooNarrow(window.innerWidth < MIN_WIDTH);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  if (!tooNarrow) return null;

  return (
    <div role="dialog" aria-modal="true" className="mobile-blocker">
      <h2>Greenhaven</h2>
      <p className="mobile-blocker__message">
        Greenhaven is a desktop-only experience. Please open it on a screen
        at least 1024px wide.
      </p>
      <p className="mobile-blocker__viewport">
        viewport: {typeof window === 'undefined' ? '?' : window.innerWidth}px
      </p>
    </div>
  );
}
