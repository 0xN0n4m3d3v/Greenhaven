// Spec 31 — per-token entrance animation for the live narrator stream.
// Mimics flowtoken: only the LAST chunk fades in; prior text stays
// static. Re-animating prior tokens on every delta would melt the GPU.
//
// Wire from ChatBubble.tsx for the pending bubble's text (mid-turn).
// History bubbles render plain text via renderRichMessage.

import {motion} from 'motion/react';
import {memo, useEffect, useState} from 'react';

export const StreamingTokens = memo(function StreamingTokens({
  text,
  animated,
}: {
  text: string;
  animated: boolean;
}) {
  // Track previous text length so the chunk between prev and current
  // is the new tail to animate.
  const [prevLen, setPrevLen] = useState(text.length);
  useEffect(() => {
    setPrevLen(text.length);
  }, [text]);

  if (!animated || text.length === 0) return <>{text}</>;
  // On a fresh render we don't know the diff, so just animate the last
  // ~12 chars unconditionally — close enough to per-token without
  // tracking deltas precisely.
  const tailStart = Math.max(0, prevLen - 12, text.length - 12);
  const head = text.slice(0, tailStart);
  const tail = text.slice(tailStart);

  return (
    <>
      {head}
      <motion.span
        key={tailStart}
        initial={{opacity: 0, y: 4}}
        animate={{opacity: 1, y: 0}}
        transition={{duration: 0.18, ease: 'easeOut'}}
      >
        {tail}
      </motion.span>
    </>
  );
});
