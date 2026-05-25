// Full-screen first-run language selector for the mounted app path.
// Mirrors the boot selector: a compact carousel instead of a button wall.

import {motion} from 'motion/react';
import {useCallback, useEffect, useState} from 'react';
import {GetAvailableLanguages, i18n as i18nModels} from './bridge/platform';
import {useTranslation} from './i18n';

type Lang = i18nModels.Language;

export function LanguagePicker() {
    const {setLanguage} = useTranslation();
    const [languages, setLanguages] = useState<Lang[]>([]);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [picking, setPicking] = useState<string | null>(null);
    const [err, setErr] = useState('');

    useEffect(() => {
        let alive = true;
        GetAvailableLanguages()
            .then((list) => {
                if (alive && list) setLanguages(list);
            })
            .catch((e) => {
                if (alive) setErr(String(e));
            });
        return () => {
            alive = false;
        };
    }, []);

    useEffect(() => {
        setSelectedIndex(index => {
            if (languages.length === 0) return 0;
            return Math.min(index, languages.length - 1);
        });
    }, [languages.length]);

    const selected = languages[selectedIndex] ?? null;

    const choose = useCallback(async (code: string) => {
        if (picking) return;
        setPicking(code);
        try {
            await setLanguage(code);
        } catch (e) {
            setErr(String(e));
            setPicking(null);
        }
    }, [picking, setLanguage]);

    const stepLanguage = useCallback((delta: number) => {
        if (picking || languages.length === 0) return;
        setSelectedIndex(index => (
            index + delta + languages.length
        ) % languages.length);
    }, [languages.length, picking]);

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'ArrowLeft') {
                event.preventDefault();
                stepLanguage(-1);
            } else if (event.key === 'ArrowRight') {
                event.preventDefault();
                stepLanguage(1);
            } else if ((event.key === 'Enter' || event.key === ' ') && selected) {
                event.preventDefault();
                void choose(selected.code);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [choose, selected, stepLanguage]);

    return (
        <div className="language-picker">
            <motion.div
                className="language-picker-card language-picker-card--compact"
                initial={{opacity: 0, y: 14, scale: 0.98}}
                animate={{opacity: 1, y: 0, scale: 1}}
                transition={{type: 'spring', stiffness: 240, damping: 24}}
            >
                {selected ? (
                    <div className="boot-lang boot-lang--inline" aria-label="Language">
                        <button
                            type="button"
                            className="boot-lang__arrow"
                            onClick={() => stepLanguage(-1)}
                            disabled={picking !== null}
                            aria-label="Previous language"
                        >
                            {'<'}
                        </button>
                        <button
                            type="button"
                            className={`boot-lang__current ${picking === selected.code ? 'is-picking' : ''}`}
                            onClick={() => void choose(selected.code)}
                            disabled={picking !== null && picking !== selected.code}
                            aria-label={selected.native || selected.code}
                        >
                            <span className="boot-lang__flag" aria-hidden="true">{selected.flag}</span>
                            <span className="boot-lang__native">{selected.native}</span>
                            <span className="boot-lang__code">{selected.code}</span>
                        </button>
                        <button
                            type="button"
                            className="boot-lang__arrow"
                            onClick={() => stepLanguage(1)}
                            disabled={picking !== null}
                            aria-label="Next language"
                        >
                            {'>'}
                        </button>
                    </div>
                ) : (
                    <p className="language-picker-footnote">Loading...</p>
                )}
                {err && <p className="language-picker-error">{err}</p>}
            </motion.div>
        </div>
    );
}
