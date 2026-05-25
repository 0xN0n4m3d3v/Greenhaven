// Main menu - shown after the title screen is dismissed, before
// WizardGate fetches the profile and routes to wizard or app.
// It lives outside TranslationProvider, so boot menu localization uses
// src/lib/bootI18n.ts and the language stored by BootLanguagePicker.
//
// FEAT-ENGINE-BASELINE-6 — the menu no longer calls
// `GetCurrentPlayerId()` / `GetPlayerProfile()` to decide which
// buttons to show. BootGate fetches `GetLibraryStatus()` (read-only,
// no auth) and passes it in via `libraryStatus`; we derive Continue /
// Worlds & Heroes affordances from an active launched playthrough.
// A created hero plus an installed world is not a save until the
// player explicitly launches that pair in Worlds & Heroes. The legacy "New game"
// button (which called `ResetGame()` and globally wiped the world)
// was removed in this pass — per-hero / per-cartridge new game now
// lives in Worlds & Heroes and goes through
// `/api/playthroughs/new-game`.

import type {ReactNode} from 'react';
import {useCallback, useEffect, useRef, useState} from 'react';
import type {LibraryStatusView} from '../bridge/api';
import {bootTextForLanguage, type BootText} from '../lib/bootI18n';

function brandCopy(language: string): {eyebrow: string; tagline: string} {
  switch (language) {
    case 'ru':
      return {
        eyebrow: 'Живой RPG-роман',
        tagline:
          'Игровой фэнтези-мир, где память, квесты, инвентарь, связи и последствия переживают каждую сцену.',
      };
    case 'uk':
      return {
        eyebrow: 'Живий RPG-роман',
        tagline:
          'Ігровий фентезі-світ, де памʼять, квести, інвентар, звʼязки й наслідки переживають кожну сцену.',
      };
    default:
      return {
        eyebrow: 'Living RPG novel',
        tagline:
          'A playable fantasy world where memory, quests, inventory, bonds, and consequences survive the scene.',
      };
  }
}

interface Props {
    /** Continue an existing playthrough (heroes + ready cartridge available). */
    onContinue: () => void;
    /** Open the separate boot settings screen. */
    onSettings: () => void;
    /** Open the FEAT-CART-LIB-5 Worlds & Heroes library screen. */
    onLibrary: () => void;
    /** Current boot UI language code. */
    language: string;
    /** FEAT-ENGINE-BASELINE-6 — read-only library status. The menu
     *  uses `activePlaythroughCount` to decide whether Continue is
     *  enabled. Null while the probe is still in flight
     *  (BootGate routes through a `status` phase before menu in
     *  practice, so this is a defensive fallback). */
    libraryStatus: LibraryStatusView | null;
}

function worldsHeroesLabel(language: string): string {
  if (language === 'ru' || language.startsWith('ru')) return 'Миры и Герои';
  if (language === 'uk' || language.startsWith('uk')) return 'Світи й Герої';
  return 'Worlds & Heroes';
}

type Modal = null | 'about' | 'licenses';

// Visual fade-out duration on handoff. Music lives one level up in
// BootGate (`BootMusic`) and continues across all boot screens, so
// no audio fade happens here.
const EXIT_FADE_MS = 800;

export function MainMenu({
    onContinue,
    onSettings,
    onLibrary,
    language,
    libraryStatus,
}: Props) {
    const [visible, setVisible] = useState(false);
    const [modal, setModal] = useState<Modal>(null);
    const [exiting, setExiting] = useState(false);
    const text = bootTextForLanguage(language);
    const brand = brandCopy(language);
    void brand;
    const dismissingRef = useRef(false);

    useEffect(() => {
        const t = window.setTimeout(() => setVisible(true), 30);
        return () => window.clearTimeout(t);
    }, []);

    /**
     * Fade the menu out visually, then run `next`. Used for handoffs
     * that unmount the menu - Continue, Exit.
     */
    const handoff = useCallback((next: () => void) => {
        if (dismissingRef.current) return;
        dismissingRef.current = true;
        setExiting(true);
        window.setTimeout(next, EXIT_FADE_MS);
    }, []);

    const closeModal = useCallback(() => setModal(null), []);
    useEffect(() => {
        if (!modal) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') closeModal();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [modal, closeModal]);

    const exit = () => {
        handoff(() => {
            // Electron exposes window.close on the renderer; in a plain
            // browser tab the call is ignored unless the tab was opened
            // via window.open, which is acceptable.
            try { window.close(); } catch { /* noop */ }
        });
    };

    // Continue is enabled only after Worlds & Heroes has launched at
    // least one concrete (hero, cartridge) playthrough. This avoids
    // the broken path where a fresh hero plus a ready cartridge looked
    // like a save even though no hero had entered any world yet.
    const activePlaythroughCount = libraryStatus?.activePlaythroughCount ?? 0;
    const canContinue = activePlaythroughCount > 0;

    const cls = [
        'title-menu',
        visible && !exiting ? 'title-menu--in' : '',
        exiting ? 'title-menu--out' : '',
    ].filter(Boolean).join(' ');

    return (
        <main className={`${cls} gh-screen gh-title-menu`}>
            <section className="title-menu__panel gh-menu-panel" aria-label={text.mainAria}>
                {/*
                <header className="title-menu__brand">
                    <p className="title-menu__eyebrow">{brand.eyebrow}</p>
                    <h1>Greenhaven</h1>
                    <p className="title-menu__tagline">
                        {brand.tagline}
                    </p>
                </header>
                */}

                <nav className="title-menu__list gh-menu-list" aria-label={text.mainAria}>
                <MenuButton
                    variant="primary"
                    onClick={() => handoff(onContinue)}
                    disabled={!canContinue}
                    hint={undefined}
                >
                    {text.continue}
                </MenuButton>
                <MenuButton onClick={onLibrary} variant="primary">
                    {worldsHeroesLabel(language)}
                </MenuButton>
                <MenuButton onClick={onSettings}>
                    {text.settings}
                </MenuButton>
                <MenuButton onClick={() => setModal('about')}>
                    {text.about}
                </MenuButton>
                <MenuButton onClick={() => setModal('licenses')}>
                    {text.licenses}
                </MenuButton>
                <MenuButton onClick={exit}>
                    {text.exit}
                </MenuButton>
                </nav>
            </section>

            {modal && (
                <MenuModal kind={modal} onClose={closeModal} text={text}/>
            )}
        </main>
    );
}

interface MenuButtonProps {
    children: ReactNode;
    onClick: () => void;
    disabled?: boolean;
    hint?: string;
    variant?: 'primary' | 'secondary';
}

function MenuButton({children, onClick, disabled, hint, variant = 'secondary'}: MenuButtonProps) {
    return (
        <button
            type="button"
            className={`title-menu__btn title-menu__btn--${variant} gh-control gh-menu-action`}
            onClick={onClick}
            disabled={disabled}
            title={hint}
        >
            <span className="title-menu__btn-label">{children}</span>
            {hint && <span className="title-menu__btn-hint">{hint}</span>}
        </button>
    );
}

interface ModalProps {
    kind: NonNullable<Modal>;
    onClose: () => void;
    text: BootText;
}

function MenuModal({kind, onClose, text}: ModalProps) {
    return (
        <div className="title-modal__backdrop gh-modal-backdrop" onClick={onClose} role="dialog" aria-modal="true">
            <div
                className="title-modal gh-panel gh-modal"
                onClick={(e) => e.stopPropagation()}
            >
                <header className="title-modal__head">
                    <h2>{kind === 'about' ? text.aboutTitle : text.licensesTitle}</h2>
                    <button
                        type="button"
                        className="title-modal__close"
                        onClick={onClose}
                        aria-label={text.close}
                    >
                        x
                    </button>
                </header>
                <div className="title-modal__body">
                    {kind === 'about' ? (
                        <>
                            <p>{text.aboutBody1}</p>
                            <p><strong>{text.aboutBody2}</strong></p>
                            <p>{text.aboutBody3}</p>
                            <ul className="title-modal__links" aria-label="Project links">
                                <li>
                                    <span>Website</span>
                                    <a href="https://greenhaven.quest/?lang=en" target="_blank" rel="noreferrer">
                                        greenhaven.quest
                                    </a>
                                </li>
                                <li>
                                    <span>Patreon</span>
                                    <a href="https://www.patreon.com/cw/greenhavenquest" target="_blank" rel="noreferrer">
                                        patreon.com/cw/greenhavenquest
                                    </a>
                                </li>
                                <li>
                                    <span>Email</span>
                                    <a href="mailto:author@greenhaven.quest">
                                        author@greenhaven.quest
                                    </a>
                                </li>
                            </ul>
                        </>
                    ) : (
                        <>
                            <p>{text.licensesBody1}</p>
                            <p>{text.licensesBody2}</p>
                            <p>{text.licensesBody3}</p>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

