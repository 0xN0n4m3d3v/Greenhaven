// Spec 32 — NPC portrait component.
//
// Layered: cartridge-supplied URL set (profile.portrait_set keyed by
// mood) → procedural fallback (initial monogram on hash-derived hue).
// Crossfade on mood swap. Bridge subscribes to portrait:set SSE
// (emitted via narrate's # portrait directive) → re-renders.

import {useMemo} from 'react';
import {AnimatePresence, motion} from 'motion/react';
import {isVideoAsset} from '../media/MediaAsset';

interface Props {
  npcId: number;
  name: string;
  /** entities.profile.portrait_set — { default: '...', amused: '...', wounded: '...' } */
  portraitSet?: Record<string, string | null>;
  /** Active mood key — falls back to 'default' if mood not in set. */
  mood?: string;
  size?: 'sm' | 'md' | 'lg';
}

export function Portrait({npcId, name, portraitSet, mood = 'default', size = 'md'}: Props) {
  const url = portraitSet?.[mood] ?? portraitSet?.['default'] ?? null;
  const dim = size === 'sm' ? 32 : size === 'md' ? 48 : 96;

  const hue = useMemo(() => {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return h % 360;
  }, [name]);
  const initial = name.trim()[0]?.toUpperCase() ?? '?';

  return (
    <div className="relative flex-none" style={{width: dim, height: dim}}>
      <AnimatePresence mode="wait">
        {url ? (
          isVideoAsset(url) ? (
            <motion.video
              key={`${npcId}-${mood}-${url}`}
              src={url}
              muted
              autoPlay
              loop
              playsInline
              preload="metadata"
              aria-label={`${name} (${mood})`}
              initial={{opacity: 0, scale: 1.04}}
              animate={{opacity: 1, scale: 1}}
              exit={{opacity: 0, scale: 0.96}}
              transition={{duration: 0.32}}
              style={{
                width: '100%',
                height: '100%',
                borderRadius: 0,
                objectFit: 'cover',
              }}
            />
          ) : (
            <motion.img
              key={`${npcId}-${mood}-${url}`}
              src={url}
              alt={`${name} (${mood})`}
              initial={{opacity: 0, scale: 1.04}}
              animate={{opacity: 1, scale: 1}}
              exit={{opacity: 0, scale: 0.96}}
              transition={{duration: 0.32}}
              style={{
                width: '100%',
                height: '100%',
                borderRadius: 0,
                objectFit: 'cover',
              }}
            />
          )
        ) : (
          <motion.div
            key={`${npcId}-fallback-${mood}`}
            initial={{opacity: 0}}
            animate={{opacity: 1}}
            exit={{opacity: 0}}
            transition={{duration: 0.32}}
            style={{
              width: '100%',
              height: '100%',
              borderRadius: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 700,
              background: `hsl(${hue} 42% 28%)`,
              color: `hsl(${hue} 30% 92%)`,
              fontSize: dim * 0.45,
              fontFamily: 'var(--font-ui)',
            }}
          >
            {initial}
          </motion.div>
        )}
      </AnimatePresence>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: 0,
          pointerEvents: 'none',
          boxShadow:
            'inset 0 0 0 2px hsl(var(--border)), inset 0 0 12px hsl(var(--background) / 0.4)',
        }}
      />
    </div>
  );
}
