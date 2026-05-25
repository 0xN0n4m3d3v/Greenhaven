// Spec 37 — magnetic cursor with lerp easing.
// Sticks to weighted-choice buttons (data-weight="heavy") with a
// 6px pull radius. Custom 18px ring with mix-blend-mode: difference.
// Hides on touch devices + prefers-reduced-motion.

import {useEffect, useRef} from 'react';

const LERP = 0.12;
const PULL_RADIUS = 6;

export function MagneticCursor() {
  const ref = useRef<HTMLDivElement>(null);
  const pos = useRef({x: 0, y: 0, tx: 0, ty: 0});

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.matchMedia('(pointer: coarse)').matches) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let raf = 0;
    const onMove = (e: MouseEvent) => {
      pos.current.tx = e.clientX;
      pos.current.ty = e.clientY;
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const weighted = el?.closest('[data-weight="heavy"]') as HTMLElement | null;
      if (weighted) {
        const r = weighted.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const dx = cx - e.clientX;
        const dy = cy - e.clientY;
        const dist = Math.hypot(dx, dy);
        if (dist < r.width / 2 + PULL_RADIUS) {
          pos.current.tx += dx * 0.4;
          pos.current.ty += dy * 0.4;
          ref.current?.classList.add('cursor-magnetic');
        } else {
          ref.current?.classList.remove('cursor-magnetic');
        }
      } else {
        ref.current?.classList.remove('cursor-magnetic');
      }
    };
    const tick = () => {
      pos.current.x += (pos.current.tx - pos.current.x) * LERP;
      pos.current.y += (pos.current.ty - pos.current.y) * LERP;
      if (ref.current) {
        ref.current.style.transform = `translate(${pos.current.x - 9}px, ${pos.current.y - 9}px)`;
      }
      raf = requestAnimationFrame(tick);
    };
    document.addEventListener('mousemove', onMove);
    raf = requestAnimationFrame(tick);
    return () => {
      document.removeEventListener('mousemove', onMove);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div
      ref={ref}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: 18,
        height: 18,
        border: '1px solid hsl(var(--ember))',
        borderRadius: 0,
        pointerEvents: 'none',
        zIndex: 9999,
        mixBlendMode: 'difference',
        transition: 'width 0.18s, height 0.18s, border-color 0.18s',
      }}
      aria-hidden
    />
  );
}
