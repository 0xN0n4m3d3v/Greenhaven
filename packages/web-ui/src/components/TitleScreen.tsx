import {useCallback, useEffect, useRef, useState} from 'react';

interface Props {
    onEnter: () => void;
}

/**
 * Cosmetic title screen shown before any app work begins. Press Space
 * / Enter / click to enter the game. Music lives one level up in
 * BootGate (`BootMusic`) so it plays uninterrupted across all boot
 * screens — this component only handles its own visual fade-in/out.
 */
export function TitleScreen({onEnter}: Props) {
    const [visible, setVisible] = useState(false);
    const [exiting, setExiting] = useState(false);
    const dismissingRef = useRef(false);

    useEffect(() => {
        const t = window.setTimeout(() => setVisible(true), 30);
        return () => window.clearTimeout(t);
    }, []);

    const dismiss = useCallback(() => {
        if (dismissingRef.current) return;
        dismissingRef.current = true;
        setExiting(true);
        // Match the CSS opacity transition (0.9s). Music is shared
        // across boot screens via BootMusic — we don't fade it here.
        window.setTimeout(onEnter, 900);
    }, [onEnter]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.code === 'Space' || e.key === ' ' || e.key === 'Enter') {
                e.preventDefault();
                dismiss();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [dismiss]);

    const cls = [
        'title-screen',
        visible && !exiting ? 'title-screen--in' : '',
        exiting ? 'title-screen--out' : '',
    ].filter(Boolean).join(' ');

    return (
        <main
            className={`${cls} gh-screen gh-title-screen`}
            onClick={dismiss}
            role="button"
            tabIndex={0}
            aria-label="Press Space to begin"
        >
            <h1 className="title-screen__wordmark">Greenhaven</h1>
            <div className="title-screen__prompt">
                <span className="title-screen__key">Space</span>
                <span className="title-screen__hint">to begin</span>
            </div>
        </main>
    );
}
