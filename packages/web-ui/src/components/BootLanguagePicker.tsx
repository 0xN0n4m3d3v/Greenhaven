// First-launch language selector shown between title and main menu.
// Compact carousel: left/right changes language, Enter selects.

import {useCallback, useEffect, useState} from 'react';
import type {FormEvent} from 'react';
import {
    normalizeSupportedLanguageCode,
    SUPPORTED_LANGUAGES,
} from '../lib/languages';
import {
    getDeepSeekKeyStatus,
    saveDeepSeekApiKey,
    type DeepSeekKeyStatus,
} from '../lib/desktopConfig';

const STORAGE_KEY = 'greenhaven.uiLanguage';

interface Props {
    onPicked: (language: string) => void;
}

/** Read the persisted UI language without going through the bridge. */
export function readSavedLanguage(): string | null {
    try {
        const v = window.localStorage.getItem(STORAGE_KEY);
        return normalizeSupportedLanguageCode(v);
    } catch {
        return null;
    }
}

export function writeSavedLanguage(code: string): string | null {
    const normalized = normalizeSupportedLanguageCode(code);
    if (!normalized) return null;
    try {
        window.localStorage.setItem(STORAGE_KEY, normalized);
    } catch {
        // localStorage unavailable; caller can keep the transient selection.
    }
    return normalized;
}

export function BootLanguagePicker({onPicked}: Props) {
    const [visible, setVisible] = useState(false);
    const [picking, setPicking] = useState<string | null>(null);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [deepSeekKey, setDeepSeekKey] = useState('');
    const [deepSeekStatus, setDeepSeekStatus] = useState<DeepSeekKeyStatus | null>(null);
    const [deepSeekBusy, setDeepSeekBusy] = useState(false);
    const [deepSeekNotice, setDeepSeekNotice] = useState('');
    const selected = (
        SUPPORTED_LANGUAGES[selectedIndex] ?? SUPPORTED_LANGUAGES[0]
    )!;
    const shouldAskDeepSeekKey = deepSeekStatus?.source === 'none';

    useEffect(() => {
        const t = window.setTimeout(() => setVisible(true), 30);
        return () => window.clearTimeout(t);
    }, []);

    useEffect(() => {
        let cancelled = false;
        getDeepSeekKeyStatus().then(status => {
            if (!cancelled) setDeepSeekStatus(status);
        });
        return () => {
            cancelled = true;
        };
    }, []);

    const choose = useCallback((code: string) => {
        if (picking) return;
        const normalized = writeSavedLanguage(code);
        if (!normalized) return;
        setPicking(normalized);
        window.setTimeout(() => onPicked(normalized), 240);
    }, [onPicked, picking]);

    const stepLanguage = useCallback((delta: number) => {
        if (picking) return;
        setSelectedIndex(index => (
            index + delta + SUPPORTED_LANGUAGES.length
        ) % SUPPORTED_LANGUAGES.length);
    }, [picking]);

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'ArrowLeft') {
                event.preventDefault();
                stepLanguage(-1);
            } else if (event.key === 'ArrowRight') {
                event.preventDefault();
                stepLanguage(1);
            } else if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                choose(selected.code);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [choose, selected.code, stepLanguage]);

    const saveKey = async (event: FormEvent) => {
        event.preventDefault();
        const value = deepSeekKey.trim();
        if (!value || deepSeekBusy) return;
        setDeepSeekBusy(true);
        setDeepSeekNotice('');
        const status = await saveDeepSeekApiKey(value);
        setDeepSeekStatus(status);
        setDeepSeekKey('');
        setDeepSeekNotice(
            status.source === 'local'
                ? 'DeepSeek key saved.'
                : 'DeepSeek key is not available in this build.',
        );
        setDeepSeekBusy(false);
    };

    return (
        <main className={`title-menu ${visible ? 'title-menu--in' : ''}`}>
            <div className="boot-setup">
                <div className="boot-lang" aria-label="Language">
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
                        onClick={() => choose(selected.code)}
                        disabled={picking !== null && picking !== selected.code}
                        aria-label={selected.name}
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
                <button
                    type="button"
                    className="boot-lang__start"
                    onClick={() => choose(selected.code)}
                    disabled={picking !== null}
                >
                    Start
                </button>
                {shouldAskDeepSeekKey && (
                    <form className="boot-key" onSubmit={saveKey}>
                        <label htmlFor="boot-deepseek-key">DeepSeek API key</label>
                        <div className="boot-key__row">
                            <input
                                id="boot-deepseek-key"
                                type="password"
                                value={deepSeekKey}
                                onChange={event => setDeepSeekKey(event.target.value)}
                                placeholder="Paste key"
                                autoComplete="off"
                                spellCheck={false}
                                maxLength={4096}
                                disabled={deepSeekBusy}
                            />
                            <button type="submit" disabled={!deepSeekKey.trim() || deepSeekBusy}>
                                {deepSeekBusy ? 'Saving' : 'Save'}
                            </button>
                        </div>
                    </form>
                )}
                {deepSeekNotice && (
                    <p className="boot-key__notice" role="status">{deepSeekNotice}</p>
                )}
            </div>
        </main>
    );
}
