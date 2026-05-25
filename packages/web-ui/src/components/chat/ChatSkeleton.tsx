// Spec 31 - skeleton loader for non-chat surfaces.
//
// Mounted on:
//   - WizardGate loading phase (pre-profile fetch, before <App/> mounts)
//   - Save-slot restore (between POST /api/saves/:id/restore and
//     bridge state rebuild)
//   - Quest panel initial load
//
// Pulsing avatar + 3 lines of varying-width gradient bars. Mimics
// shadcn/skeleton. Honors prefers-reduced-motion.
//
// NOTE: Do NOT use this in the chat's pending bubble. The chat flow uses
// .typing-indicator, which fits the authored bubble layout.

import {motion} from 'motion/react';
import {InspirationalQuote} from '../loading/InspirationalQuote';

export function ChatSkeleton({
  sceneTags = [],
  showQuote = false,
}: {
  sceneTags?: string[];
  showQuote?: boolean;
} = {}) {
  return (
    <>
      {showQuote && <InspirationalQuote sceneTags={sceneTags} />}
      <article className="chat-skeleton" aria-label="Loading...">
        <motion.div
          className="chat-skeleton__avatar"
          animate={{opacity: [0.5, 0.9, 0.5]}}
          transition={{duration: 1.4, repeat: Infinity}}
        />
        <div className="chat-skeleton__lines">
          {[0.85, 0.95, 0.6].map((w, i) => (
            <motion.div
              key={i}
              className="chat-skeleton__line"
              style={{width: `${w * 100}%`}}
              animate={{
                opacity: [0.4, 0.8, 0.4],
                backgroundPosition: ['0% 0%', '100% 0%'],
              }}
              transition={{duration: 1.4, repeat: Infinity, delay: i * 0.15}}
            />
          ))}
        </div>
      </article>
    </>
  );
}
