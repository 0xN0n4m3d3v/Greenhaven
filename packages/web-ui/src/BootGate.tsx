// BootGate — absolute outermost gate. Stages:
//   title    cosmetic title screen
//   language first-launch language picker (skipped if already chosen)
//   status   FEAT-ENGINE-BASELINE-6 library-status probe — fetched
//            BEFORE the player bootstrap so we can route into Worlds &
//            Heroes when nothing is installed yet (clean baseline).
//   menu     main menu (Continue / Worlds & Heroes / Settings / …)
//   library  Worlds & Heroes screen
//   settings boot-time settings
//   enter    children render (TranslationProvider, WizardGate, App)
//
// FEAT-ENGINE-BASELINE-6 — the boot menu no longer fetches
// `GetCurrentPlayerId()` / `GetPlayerProfile()` to decide what to
// show. Instead we read `GetLibraryStatus()` once (ready-cartridge
// count + hero count + active playthrough count + default Forge
// project availability) and use
// that to pick the next phase. On a clean baseline (no installed
// cartridge, no heroes, or no explicitly launched hero/world pair)
// we strongly route into Worlds & Heroes instead of entering gameplay
// or character creation.
//
// Music: a single <BootMusic> element lives here at the gate level
// and plays uninterrupted across every boot phase. It only fades out
// when the player enters the game (phase = 'enter').

import {Suspense, lazy, useCallback, useEffect, useState} from 'react';
import {GetLibraryStatus, type LibraryStatusView} from './bridge/api';
import {TitleScreen} from './components/TitleScreen';
import {MainMenu} from './components/MainMenu';
import {BootLanguagePicker, readSavedLanguage} from './components/BootLanguagePicker';
import {BootSettingsScreen} from './components/BootSettingsScreen';
import {BootMusic} from './components/BootMusic';
import {BootMediaBackdrop} from './components/BootMediaBackdrop';
// Side-effect import: picks the (image, audio) bundle and publishes
// the image URL to :root as `--boot-bg-url` before any boot screen
// renders. Module evaluates once.
import {bootVideoUrl as fallbackBootVideoUrl} from './lib/bootBackground';

const WorldsHeroesScreen = lazy(() =>
    import('./components/cartridge-library/WorldsHeroesScreen').then((module) => ({
        default: module.WorldsHeroesScreen,
    })),
);

interface Props {
    children: React.ReactNode;
}

type Phase = 'title' | 'language' | 'status' | 'menu' | 'settings' | 'library' | 'enter';

type BootMediaBundleView = NonNullable<
    NonNullable<LibraryStatusView['bootMedia']>['bundles'][number]
>;

function pickBundleIndex(length: number): number {
    if (length <= 0) return -1;
    try {
        const raw = new URLSearchParams(window.location.search).get('launch');
        if (raw !== null) {
            const n = parseInt(raw, 10);
            if (Number.isFinite(n)) return ((n % length) + length) % length;
        }
    } catch { /* noop */ }
    return 0;
}

function pickCartridgeBootBundle(
    status: LibraryStatusView | null,
): BootMediaBundleView | null {
    const bundles = status?.bootMedia?.bundles;
    if (!Array.isArray(bundles) || bundles.length === 0) return null;
    const videoBundles = bundles.filter((bundle) => Boolean(bundle.videoUrl));
    const preferred = videoBundles.length > 0 ? videoBundles : bundles;
    const idx = pickBundleIndex(preferred.length);
    return idx >= 0 ? preferred[idx] ?? null : null;
}

export function BootGate({children}: Props) {
    const [phase, setPhase] = useState<Phase>('title');
    const [bootLanguage, setBootLanguage] = useState<string>(() => readSavedLanguage() ?? 'en');
    const [libraryStatus, setLibraryStatus] = useState<LibraryStatusView | null>(null);
    const [cartridgeBootBundle, setCartridgeBootBundle] =
        useState<BootMediaBundleView | null>(null);
    const [statusError, setStatusError] = useState<string | null>(null);

    const fetchStatus = useCallback(async () => {
        setStatusError(null);
        try {
            const next = await GetLibraryStatus();
            setLibraryStatus(next);
            setCartridgeBootBundle(pickCartridgeBootBundle(next));
            return next;
        } catch (err) {
            setStatusError(err instanceof Error ? err.message : String(err));
            return null;
        }
    }, []);

    useEffect(() => {
        void fetchStatus();
    }, [fetchStatus]);

    useEffect(() => {
        const posterUrl = cartridgeBootBundle?.posterUrl;
        if (!posterUrl || cartridgeBootBundle?.videoUrl) return;
        document.documentElement.style.setProperty(
            '--boot-bg-url',
            `url("${posterUrl.replace(/"/g, '\\"')}")`,
        );
    }, [cartridgeBootBundle?.posterUrl, cartridgeBootBundle?.videoUrl]);

    const activeBootVideoUrl =
        cartridgeBootBundle?.videoUrl ?? fallbackBootVideoUrl ?? null;

    const afterTitle = () => {
        const saved = readSavedLanguage();
        if (saved) setBootLanguage(saved);
        setPhase(saved ? 'status' : 'language');
    };

    // Fetch library status whenever we (re)enter the `status` phase so
    // the menu / library decision is taken from server truth, not from
    // a stale snapshot. Re-fetching also happens when the user returns
    // from the library screen — they may have just imported a
    // cartridge or created a hero.
    useEffect(() => {
        if (phase !== 'status') return;
        let cancelled = false;
        void fetchStatus().then((status) => {
            if (cancelled || !status) return;
            const noReadyCartridge = status.readyCartridgeCount <= 0;
            const noHero = status.heroCount <= 0;
            const noActivePlaythrough = status.activePlaythroughCount <= 0;
            setPhase(
                noReadyCartridge || noHero || noActivePlaythrough
                    ? 'library'
                    : 'menu',
            );
        });
        return () => {
            cancelled = true;
        };
    }, [phase, fetchStatus]);

    const onLibraryBack = useCallback(() => {
        // Back means "show the menu". We still refresh the read-only
        // library status in the background so Continue/Worlds affordances
        // reflect any import or hero changes, but we must not route back
        // through `status`: on a clean baseline that would immediately
        // force-open Worlds & Heroes again and trap the player.
        void fetchStatus();
        setPhase('menu');
    }, [fetchStatus]);

    let screen: React.ReactNode;
    if (phase === 'title') {
        screen = (
            <TitleScreen
                onEnter={afterTitle}
            />
        );
    } else if (phase === 'language') {
        screen = (
            <BootLanguagePicker
                onPicked={(language) => {
                    setBootLanguage(language);
                    setPhase('status');
                }}
            />
        );
    } else if (phase === 'status') {
        screen = (
            <BootStatusScreen
                language={bootLanguage}
                errorMessage={statusError}
                onRetry={() => void fetchStatus()}
            />
        );
    } else if (phase === 'menu') {
        screen = (
            <MainMenu
                language={bootLanguage}
                libraryStatus={libraryStatus}
                onContinue={() => setPhase('enter')}
                onLibrary={() => setPhase('library')}
                onSettings={() => setPhase('settings')}
            />
        );
    } else if (phase === 'settings') {
        screen = (
            <BootSettingsScreen
                language={bootLanguage}
                onLanguageChange={setBootLanguage}
                onBack={() => setPhase('menu')}
            />
        );
    } else if (phase === 'library') {
        screen = (
            <Suspense
                fallback={
                    <BootStatusScreen
                        language={bootLanguage}
                        errorMessage={null}
                        onRetry={() => void fetchStatus()}
                    />
                }
            >
                <WorldsHeroesScreen
                    language={bootLanguage}
                    libraryStatus={libraryStatus}
                    onBack={onLibraryBack}
                    onEnterGame={() => setPhase('enter')}
                />
            </Suspense>
        );
    } else {
        screen = children;
    }

    // BootMusic stays mounted across title → language → menu so the
    // track plays continuously, then fades out as the player enters
    // the game. Once phase === 'enter' it stays mounted just long
    // enough to finish the fade; harmless after that since the audio
    // element is silent and the children own the screen.
    return (
        <>
            <BootMusic
                fadingOut={phase === 'enter'}
                musicUrl={cartridgeBootBundle?.musicUrl ?? null}
            />
            {phase !== 'enter' && (
                <BootBackdropLayer videoUrl={activeBootVideoUrl}/>
            )}
            {screen}
        </>
    );
}

function BootBackdropLayer({videoUrl}: {videoUrl?: string | null}) {
    return (
        <div className="boot-backdrop-layer" aria-hidden="true">
            <BootMediaBackdrop videoUrl={videoUrl}/>
            <div className="title-screen__vignette"/>
        </div>
    );
}

interface BootStatusScreenProps {
    language: string;
    errorMessage: string | null;
    onRetry: () => void;
}

function statusLabel(language: string): {loading: string; error: string; retry: string} {
    if (language === 'ru' || language.startsWith('ru')) {
        return {
            loading: 'Проверяю установленные миры...',
            error: 'Не удалось прочитать состояние библиотеки.',
            retry: 'Повторить',
        };
    }
    if (language === 'uk' || language.startsWith('uk')) {
        return {
            loading: 'Перевіряю встановлені світи...',
            error: 'Не вдалося прочитати стан бібліотеки.',
            retry: 'Повторити',
        };
    }
    return {
        loading: 'Checking installed worlds...',
        error: 'Could not read the library state.',
        retry: 'Try again',
    };
}

function BootStatusScreen({
    language,
    errorMessage,
    onRetry,
}: BootStatusScreenProps) {
    const text = statusLabel(language);
    return (
        <main className="gh-boot-screen" role="status" aria-live="polite">
            {/*
            <div className="gh-boot-mark">Greenhaven</div>
            */}
            {errorMessage ? (
                <>
                    <p className="gh-boot-hint">{text.error}</p>
                    <pre className="gh-boot-error">{errorMessage}</pre>
                    <button
                        type="button"
                        className="gh-boot-retry"
                        onClick={onRetry}
                    >
                        {text.retry}
                    </button>
                </>
            ) : (
                <>
                    <p className="gh-boot-hint"><em>{text.loading}</em></p>
                    <div className="gh-boot-spinner" aria-hidden/>
                </>
            )}
        </main>
    );
}

