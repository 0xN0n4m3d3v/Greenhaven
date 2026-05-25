// Spec 37 §8 carried-over and U-4 language-aware quote loading.

import {AnimatePresence, motion} from 'motion/react';
import {useEffect, useState} from 'react';
import {loadInspirationalQuote} from '../../bridge/quotes';
import {useTranslation} from '../../i18n';

export interface InspirationalQuoteProps {
  /** Current scene tags (e.g. ['tavern','lavender']). Empty = no filter. */
  sceneTags?: string[];
  /** Deprecated: quote text is resolved by /api/quotes/inspirational. */
  resolveKey?: (key: string) => string;
  baseUrl?: string;
}

export function InspirationalQuote({
  sceneTags = [],
}: InspirationalQuoteProps) {
  const {language} = useTranslation();
  const [quote, setQuote] = useState<{
    text: string;
    attribution: string | null;
  } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    loadInspirationalQuote(language ?? 'en', sceneTags, controller.signal)
      .then((pick) => {
        if (!pick) {
          setQuote(null);
          return;
        }
        setQuote({
          text: pick.text,
          attribution: pick.attribution,
        });
      })
      .catch(() => {});
    return () => {
      controller.abort();
    };
  }, [sceneTags.join(','), language]);

  if (!quote) return null;
  return (
    <AnimatePresence>
      <motion.figure
        initial={{opacity: 0}}
        animate={{opacity: 1}}
        exit={{opacity: 0}}
        transition={{duration: 1.2}}
        className="inspirational-quote"
      >
        <blockquote>{quote.text}</blockquote>
        {quote.attribution && (
          <figcaption>
            - {quote.attribution}
          </figcaption>
        )}
      </motion.figure>
    </AnimatePresence>
  );
}
