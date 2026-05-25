import {useCallback, useEffect, useMemo, useState} from 'react';
import type {FormEvent} from 'react';
import {ChevronLeft, KeyRound, Save, Trash2} from 'lucide-react';
import {SUPPORTED_LANGUAGES} from '../lib/languages';
import {bootTextForLanguage} from '../lib/bootI18n';
import {
    getDeepSeekKeyStatus,
    saveDeepSeekApiKey,
    type DeepSeekKeyStatus,
} from '../lib/desktopConfig';
import {writeSavedLanguage} from './BootLanguagePicker';

interface Props {
    language: string;
    onLanguageChange: (language: string) => void;
    onBack: () => void;
}

export function BootSettingsScreen({
    language,
    onLanguageChange,
    onBack,
}: Props) {
    const [visible, setVisible] = useState(false);
    const [picking, setPicking] = useState<string | null>(null);
    const [deepSeekKey, setDeepSeekKey] = useState('');
    const [deepSeekStatus, setDeepSeekStatus] = useState<DeepSeekKeyStatus | null>(null);
    const [deepSeekBusy, setDeepSeekBusy] = useState(false);
    const [deepSeekNotice, setDeepSeekNotice] = useState('');
    const [selectedLanguageIndex, setSelectedLanguageIndex] = useState(0);
    const text = bootTextForLanguage(language);
    const currentLanguage = useMemo(
        () => (
            SUPPORTED_LANGUAGES.find(lang => lang.code === language) ??
            SUPPORTED_LANGUAGES[0]
        )!,
        [language],
    );
    const deepSeekAvailable = deepSeekStatus !== null && deepSeekStatus.source !== 'unavailable';
    const deepSeekCanClear = deepSeekStatus?.source === 'local';
    const deepSeekStatusLabel = (() => {
        switch (deepSeekStatus?.source) {
            case 'local':
                return text.deepSeekStatusSaved;
            case 'environment':
                return text.deepSeekStatusEnvironment;
            case 'unavailable':
                return text.deepSeekUnavailable;
            default:
                return text.deepSeekStatusMissing;
        }
    })();

    useEffect(() => {
        const t = window.setTimeout(() => setVisible(true), 30);
        return () => window.clearTimeout(t);
    }, []);

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onBack();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onBack]);

    useEffect(() => {
        let cancelled = false;
        getDeepSeekKeyStatus().then(status => {
            if (!cancelled) setDeepSeekStatus(status);
        });
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        const index = SUPPORTED_LANGUAGES.findIndex(lang => lang.code === language);
        if (index >= 0) setSelectedLanguageIndex(index);
    }, [language]);

    const chooseLanguage = (code: string) => {
        const normalized = writeSavedLanguage(code);
        if (!normalized) return;
        setPicking(normalized);
        onLanguageChange(normalized);
        window.setTimeout(() => setPicking(null), 180);
    };

    const selectedLanguage = (
        SUPPORTED_LANGUAGES[selectedLanguageIndex] ?? currentLanguage
    )!;

    const stepLanguage = useCallback((delta: number) => {
        setSelectedLanguageIndex(index => (
            index + delta + SUPPORTED_LANGUAGES.length
        ) % SUPPORTED_LANGUAGES.length);
    }, []);

    const handleDeepSeekSave = async (event: FormEvent) => {
        event.preventDefault();
        const value = deepSeekKey.trim();
        if (!value || deepSeekBusy || !deepSeekAvailable) return;
        setDeepSeekBusy(true);
        setDeepSeekNotice('');
        const status = await saveDeepSeekApiKey(value);
        setDeepSeekStatus(status);
        setDeepSeekKey('');
        setDeepSeekNotice(
            status.source === 'unavailable'
                ? text.deepSeekUnavailable
                : text.deepSeekSavedMessage,
        );
        setDeepSeekBusy(false);
    };

    const handleDeepSeekClear = async () => {
        if (deepSeekBusy || !deepSeekCanClear) return;
        setDeepSeekBusy(true);
        setDeepSeekNotice('');
        const status = await saveDeepSeekApiKey('');
        setDeepSeekStatus(status);
        setDeepSeekKey('');
        setDeepSeekNotice(
            status.source === 'unavailable'
                ? text.deepSeekUnavailable
                : text.deepSeekClearedMessage,
        );
        setDeepSeekBusy(false);
    };

    return (
        <main className={`title-menu gh-screen gh-boot-settings ${visible ? 'title-menu--in' : ''}`}>
            <section className="boot-settings gh-panel gh-settings-workbench" aria-labelledby="boot-settings-title">
                <button
                    type="button"
                    className="boot-settings__back gh-control"
                    onClick={onBack}
                    aria-label={text.back}
                >
                    <ChevronLeft size={18}/>
                    <span>{text.back}</span>
                </button>

                <header className="boot-settings__header">
                    <p className="boot-settings__eyebrow">Greenhaven</p>
                    <h1 id="boot-settings-title">{text.settingsTitle}</h1>
                    <p>{text.settingsSubtitle}</p>
                </header>

                <div className="boot-settings__section">
                    <div>
                        <h2>{text.languageLabel}</h2>
                        <p>{text.languageHint}</p>
                    </div>
                    {currentLanguage && (
                        <div className="boot-settings__current">
                            <span>{text.currentLanguage}</span>
                            <strong>
                                <span aria-hidden="true">{currentLanguage.flag}</span>
                                {currentLanguage.native}
                            </strong>
                        </div>
                    )}
                </div>

                <div className="boot-settings__languages boot-settings__language-carousel">
                    <button
                        type="button"
                        className="boot-lang__arrow"
                        onClick={() => stepLanguage(-1)}
                        aria-label="Previous language"
                    >
                        {'<'}
                    </button>
                    <button
                        type="button"
                        className={[
                            'boot-settings__language',
                            'boot-settings__language-current',
                            selectedLanguage.code === language ? 'is-active' : '',
                            picking === selectedLanguage.code ? 'is-picking' : '',
                        ].filter(Boolean).join(' ')}
                        onClick={() => chooseLanguage(selectedLanguage.code)}
                        aria-pressed={selectedLanguage.code === language}
                        aria-label={selectedLanguage.name}
                    >
                        <span className="boot-settings__language-flag" aria-hidden="true">
                            {selectedLanguage.flag}
                        </span>
                        <span className="boot-settings__language-native">{selectedLanguage.native}</span>
                        <span className="boot-settings__language-code">{selectedLanguage.code}</span>
                    </button>
                    <button
                        type="button"
                        className="boot-lang__arrow"
                        onClick={() => stepLanguage(1)}
                        aria-label="Next language"
                    >
                        {'>'}
                    </button>
                </div>

                <form className="boot-settings__key-panel" onSubmit={handleDeepSeekSave}>
                    <div className="boot-settings__section boot-settings__section--secret">
                        <div>
                            <h2>
                                <KeyRound size={18} aria-hidden="true"/>
                                {text.deepSeekLabel}
                            </h2>
                            <p>{text.deepSeekHint}</p>
                        </div>
                        <div
                            className={[
                                'boot-settings__key-status',
                                deepSeekStatus?.saved ? 'is-saved' : '',
                            ].filter(Boolean).join(' ')}
                        >
                            {deepSeekStatusLabel}
                        </div>
                    </div>

                    <div className="boot-settings__key-row">
                        <input
                            type="password"
                            value={deepSeekKey}
                            onChange={event => setDeepSeekKey(event.target.value)}
                            placeholder={text.deepSeekPlaceholder}
                            autoComplete="off"
                            spellCheck={false}
                            maxLength={4096}
                            disabled={!deepSeekAvailable || deepSeekBusy}
                        />
                        <button
                            type="submit"
                            className="boot-settings__key-button gh-control"
                            disabled={!deepSeekKey.trim() || !deepSeekAvailable || deepSeekBusy}
                        >
                            <Save size={17} aria-hidden="true"/>
                            <span>{deepSeekBusy ? text.deepSeekSaving : text.deepSeekSave}</span>
                        </button>
                        <button
                            type="button"
                            className="boot-settings__key-button boot-settings__key-button--ghost gh-control"
                            disabled={!deepSeekCanClear || deepSeekBusy}
                            onClick={handleDeepSeekClear}
                        >
                            <Trash2 size={17} aria-hidden="true"/>
                            <span>{text.deepSeekClear}</span>
                        </button>
                    </div>
                    {deepSeekNotice && (
                        <p className="boot-settings__key-notice" role="status">
                            {deepSeekNotice}
                        </p>
                    )}
                </form>
            </section>
        </main>
    );
}
