// Spec 139 v2 — first-contact photo reveal.
//
// Fires once per NPC the first time they appear in the chat. Renders as
// a Polaroid-style photo card: dark frame, white flash burst on mount,
// shimmer-loader behind the image while the asset is loading, then the
// portrait fades in. Name + "first encounter" caption below.
//
// IMPORTANT: this is the BIG photo. The small avatar in the bubble /
// rail is a different surface — see Portrait.tsx. The photo card is a
// once-per-NPC moment, the avatar is the always-on identity chip.

import {motion} from 'motion/react';
import {useEffect, useMemo, useState} from 'react';
import {isVideoAsset} from '../media/MediaAsset';

export interface NpcRevealCardProps {
  npcId: number;
  name: string;
  portraitSet: Record<string, string | null> | null;
  /** Optional persona accent — used for the name underline. */
  accent?: string;
}

export function NpcRevealCard({name, portraitSet, accent}: NpcRevealCardProps) {
  const url = portraitSet?.['default'] ?? portraitSet?.['neutral'] ?? null;
  const initial = useMemo(() => name.trim()[0]?.toUpperCase() ?? '?', [name]);
  const hue = useMemo(() => {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return h % 360;
  }, [name]);
  const fallbackBg = `hsl(${hue}, 35%, 28%)`;

  const [imgLoaded, setImgLoaded] = useState(!url);

  // Camera flash white burst — fires once on mount.
  const [flashOn, setFlashOn] = useState(true);
  useEffect(() => {
    const id = window.setTimeout(() => setFlashOn(false), 420);
    return () => window.clearTimeout(id);
  }, []);

  return (
    <motion.div
      className="npc-photo-card"
      initial={{opacity: 0, scale: 0.94, rotate: -1.5}}
      animate={{opacity: 1, scale: 1, rotate: 0}}
      transition={{duration: 0.5, ease: [0.2, 0.8, 0.3, 1.05]}}
    >
      <div className="npc-photo-frame">
        <div className="npc-photo-image-wrap" style={!url ? {background: fallbackBg} : undefined}>
          {/* Loading shimmer — visible until the image triggers onLoad. */}
          {url && !imgLoaded && <div className="npc-photo-shimmer" aria-hidden />}
          {url ? (
            isVideoAsset(url) ? (
              <video
                src={url}
                muted
                autoPlay
                loop
                playsInline
                preload="metadata"
                aria-label={name}
                onLoadedData={() => setImgLoaded(true)}
                style={{opacity: imgLoaded ? 1 : 0}}
              />
            ) : (
              <img
                src={url}
                alt={name}
                onLoad={() => setImgLoaded(true)}
                draggable={false}
                style={{opacity: imgLoaded ? 1 : 0}}
              />
            )
          ) : (
            <span className="npc-photo-initial">{initial}</span>
          )}
          {/* Flash white burst over the photo (one-shot, fades out). */}
          {flashOn && <div className="npc-photo-flash" aria-hidden />}
        </div>
        <div className="npc-photo-caption">
          <div className="npc-photo-label">first encounter</div>
          <div
            className="npc-photo-name"
            style={accent ? {borderBottomColor: accent} : undefined}
          >
            {name}
          </div>
        </div>
      </div>
    </motion.div>
  );
}
