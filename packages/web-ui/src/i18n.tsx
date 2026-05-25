// i18n.tsx — TranslationProvider + useTranslation hook.
//
// On mount:
//   1. Reads the persisted UI language via App.GetUiLanguage().
//   2. If empty (first launch), keeps `language` as null → App
//      shows the LanguagePicker overlay until SetUiLanguage runs.
//   3. Otherwise calls App.GetTranslations(lang) and exposes t(key)
//      to the rest of the React tree.
//
// English fallback already happens on the Go side; t() just looks
// up the key in the merged map. If a key is missing (developer
// typo / new code path), t() returns the key itself so the UI
// shows ui.something_typed_wrong instead of an empty string.

import type {ReactNode} from 'react';
import {createContext, useCallback, useContext, useEffect, useMemo, useState} from 'react';
import {GetTranslations, GetUiLanguage, SetUiLanguage} from './bridge/platform';

type Translations = Record<string, string>;

type TranslationContextValue = {
    language: string | null;
    translations: Translations;
    setLanguage: (lang: string) => Promise<void>;
    ready: boolean;
};

const noopContext: TranslationContextValue = {
    language: null,
    translations: {},
    setLanguage: async () => {},
    ready: false,
};

const TranslationContext = createContext<TranslationContextValue>(noopContext);

export function TranslationProvider({children}: {children: ReactNode}) {
    const [language, setLanguageState] = useState<string | null>(null);
    const [translations, setTranslations] = useState<Translations>({});
    const [ready, setReady] = useState(false);

    // Bootstrap: read persisted language from the bridge. Empty string =
    // first launch → leave language null and ready=true so the App can
    // render the picker overlay. A real language value triggers an
    // immediate GetTranslations fetch.
    //
    // Previously this guarded against a missing Wails runtime; today
    // the bridge always responds (over HTTP for production builds, or
    // with a synchronous in-memory dictionary in dev), so the guard is
    // gone and the en/ru dictionary always loads.
    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const lang = await GetUiLanguage();
                if (!alive) return;
                if (!lang) {
                    setLanguageState(null);
                    setReady(true);
                    return;
                }
                const t = await GetTranslations(lang);
                if (!alive) return;
                setLanguageState(lang);
                setTranslations(t || {});
                setReady(true);
            } catch (err) {
                if (alive) {
                    console.error('translation bootstrap failed', err);
                    setReady(true);
                }
            }
        })();
        return () => {
            alive = false;
        };
    }, []);

    const setLanguage = useCallback(async (lang: string) => {
        const t = await SetUiLanguage(lang);
        setLanguageState(lang);
        setTranslations(t || {});
    }, []);

    const value = useMemo<TranslationContextValue>(
        () => ({language, translations, setLanguage, ready}),
        [language, translations, setLanguage, ready],
    );

    return <TranslationContext.Provider value={value}>{children}</TranslationContext.Provider>;
}

// useTranslation returns:
//   - t(key, vars?) — looks up the translation, applies {placeholder} substitution
//   - language — current locale code or null on first launch
//   - setLanguage — call from the picker
//   - ready — true once the bootstrap call resolved (loading is complete)
export function useTranslation() {
    const ctx = useContext(TranslationContext);
    const t = useCallback(
        (key: string, vars?: Record<string, string | number>): string => {
            const raw = ctx.translations[key] ?? key;
            if (!vars) return raw;
            return Object.keys(vars).reduce(
                (out, name) => out.replace(new RegExp(`\\{${name}\\}`, 'g'), String(vars[name])),
                raw,
            );
        },
        [ctx.translations],
    );
    return {
        t,
        language: ctx.language,
        setLanguage: ctx.setLanguage,
        ready: ctx.ready,
    };
}
