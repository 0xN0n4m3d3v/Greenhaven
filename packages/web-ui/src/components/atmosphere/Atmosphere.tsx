// Spec 32 — atmospheric particle layer.
//
// Pure-canvas embers/dust/rain/mist. CSS-only fallback below.
// Renders below all chat content (z-index: -1) so it never
// intercepts clicks. Honours prefers-reduced-motion (no particles).
//
// v1: hardcoded "dusk + clear → embers" preset because the backend
// doesn't yet emit world:time_set / world:weather_set events. When
// spec 32 wires those, this component will subscribe and rotate
// presets dynamically.

import {useEffect, useRef} from 'react';

type ParticleConfig = {
  count: number;
  life: [number, number];      // seconds, [min, max]
  size: [number, number];      // px, [min, max]
  colors: string[];
  yDrift: number;              // px/sec; negative = up
  xDrift: number;              // px/sec
  fade: boolean;
};

const PRESETS: Record<string, ParticleConfig> = {
  embers: {
    count: 30,
    life: [4, 9],
    size: [1, 3],
    colors: ['#ffb86b', '#ff7e3a', '#ffdd99'],
    yDrift: -22,
    xDrift: 4,
    fade: true,
  },
  dust: {
    count: 50,
    life: [8, 18],
    size: [0.5, 2],
    colors: ['#d8c8a0', '#bfae84'],
    yDrift: -6,
    xDrift: 2,
    fade: true,
  },
  rain: {
    count: 100,
    life: [0.6, 1.2],
    size: [1, 2],
    colors: ['#a0c0e0'],
    yDrift: 280,
    xDrift: 18,
    fade: false,
  },
  mist: {
    count: 12,
    life: [10, 20],
    size: [40, 80],
    colors: ['rgba(216, 208, 200, 0.3)'],
    yDrift: 4,
    xDrift: 8,
    fade: true,
  },
};

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  color: string;
  life: number;
  maxLife: number;
}

export function Atmosphere({preset = 'embers'}: {preset?: keyof typeof PRESETS}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);
  const reducedMotion = useRef(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    reducedMotion.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }, []);

  useEffect(() => {
    if (reducedMotion.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const cfg = PRESETS[preset];
    if (!cfg) return;
    const particles: Particle[] = [];

    const resize = () => {
      canvas.width = window.innerWidth * window.devicePixelRatio;
      canvas.height = window.innerHeight * window.devicePixelRatio;
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
      ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    };
    resize();
    window.addEventListener('resize', resize);

    const seed = (): Particle => {
      const lifeSec = cfg.life[0] + Math.random() * (cfg.life[1] - cfg.life[0]);
      return {
        x: Math.random() * window.innerWidth,
        y:
          cfg.yDrift > 0
            ? -10
            : window.innerHeight + 10,
        vx: (Math.random() - 0.5) * cfg.xDrift,
        vy: cfg.yDrift * (0.6 + Math.random() * 0.8),
        size: cfg.size[0] + Math.random() * (cfg.size[1] - cfg.size[0]),
        color: cfg.colors[Math.floor(Math.random() * cfg.colors.length)] ?? '#f7ead3',
        life: 0,
        maxLife: lifeSec,
      };
    };

    for (let i = 0; i < cfg.count; i++) {
      const p = seed();
      // Pre-stagger so they don't all spawn at once
      p.life = Math.random() * p.maxLife;
      p.y = Math.random() * window.innerHeight;
      particles.push(p);
    }

    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      for (const p of particles) {
        p.life += dt;
        if (
          p.life >= p.maxLife ||
          p.y < -20 ||
          p.y > window.innerHeight + 20
        ) {
          Object.assign(p, seed());
        }
        p.x += p.vx * dt;
        p.y += p.vy * dt;

        const lifePct = p.life / p.maxLife;
        const alpha = cfg.fade
          ? Math.sin(lifePct * Math.PI) // fade-in then fade-out
          : 1;
        ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      window.removeEventListener('resize', resize);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [preset]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'fixed',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 0,
        opacity: 0.7,
      }}
      aria-hidden
    />
  );
}
