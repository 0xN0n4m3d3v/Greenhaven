// BootMusic — a single persistent <audio> element that plays across
// every boot screen (title, language picker, main menu). Mounted at
// the BootGate level so it survives screen swaps without restarting,
// re-buffering, or fading. Track + paired background image come from
// `lib/bootBackground.ts` (one bundle picked once per launch).
//
// Lifecycle:
//   * mount  → fade-in from 0 to MUSIC_TARGET_VOLUME over MUSIC_FADE_IN_MS
//   * fadingOut=true → fade-out to 0 over MUSIC_FADE_OUT_MS, then pause
//
// Autoplay policy: we try `audio.play()` immediately; if the browser
// blocks it (no prior gesture), we attach a one-shot keydown/pointerdown
// listener and start the fade-in once the player makes any input.

import {useEffect, useRef} from 'react';
import {bootMusicUrl} from '../lib/bootBackground';
import {clampUnitInterval} from '../lib/audioVolume';

const MUSIC_TARGET_VOLUME = 0.55;
const MUSIC_FADE_IN_MS = 1800;
const MUSIC_FADE_OUT_MS = 1200;

interface Props {
    /** Cartridge-owned music URL. Falls back to the built-in boot
     * bundle when absent. */
    musicUrl?: string | null;
    /**
     * Set true when the boot phase is ending (player is entering the
     * game). Triggers a smooth fade-out; once volume hits 0 the
     * element pauses. Idempotent — flipping back to false won't
     * resume.
     */
    fadingOut: boolean;
}

export function BootMusic({fadingOut, musicUrl}: Props) {
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const fadeRafRef = useRef<number>(0);
    const resolvedMusicUrl = musicUrl || bootMusicUrl;
    // Generation counter shared by fade-in and fade-out. Each fade
    // bumps it before scheduling its first frame; every step closure
    // captures the generation it was scheduled under and bails if a
    // newer fade has since taken over. This prevents a stale fade-in
    // frame from writing volume after the fade-out has already started,
    // which used to surface as the renderer `IndexSizeError`.
    const fadeGenRef = useRef<number>(0);

    // Fade-in on mount.
    useEffect(() => {
        const audio = audioRef.current;
        if (!audio || !resolvedMusicUrl) return;
        audio.volume = clampUnitInterval(0);

        let cancelled = false;
        const runFadeIn = () => {
            const start = performance.now();
            const from = audio.volume;
            const to = MUSIC_TARGET_VOLUME;
            const generation = ++fadeGenRef.current;
            const step = (now: number) => {
                if (cancelled || fadeGenRef.current !== generation) return;
                const t = Math.min(1, Math.max(0, (now - start) / MUSIC_FADE_IN_MS));
                audio.volume = clampUnitInterval(from + (to - from) * t);
                if (t < 1) fadeRafRef.current = window.requestAnimationFrame(step);
            };
            fadeRafRef.current = window.requestAnimationFrame(step);
        };

        const tryPlay = () => {
            const p = audio.play();
            if (p && typeof p.then === 'function') {
                p.then(runFadeIn).catch(() => {
                    const onGesture = () => {
                        audio.play().then(runFadeIn).catch(() => {});
                        window.removeEventListener('keydown', onGesture);
                        window.removeEventListener('pointerdown', onGesture);
                    };
                    window.addEventListener('keydown', onGesture, {once: true});
                    window.addEventListener('pointerdown', onGesture, {once: true});
                });
            } else {
                runFadeIn();
            }
        };
        tryPlay();

        return () => {
            cancelled = true;
            fadeGenRef.current += 1;
            if (fadeRafRef.current) window.cancelAnimationFrame(fadeRafRef.current);
            audio.pause();
        };
    }, [resolvedMusicUrl]);

    // Fade-out when fadingOut flips true.
    useEffect(() => {
        if (!fadingOut) return;
        const audio = audioRef.current;
        if (!audio) return;

        if (fadeRafRef.current) window.cancelAnimationFrame(fadeRafRef.current);

        const start = performance.now();
        const from = audio.volume;
        const generation = ++fadeGenRef.current;
        const step = (now: number) => {
            if (fadeGenRef.current !== generation) return;
            const t = Math.min(1, Math.max(0, (now - start) / MUSIC_FADE_OUT_MS));
            audio.volume = clampUnitInterval(from * (1 - t));
            if (t < 1) {
                fadeRafRef.current = window.requestAnimationFrame(step);
            } else {
                audio.pause();
            }
        };
        fadeRafRef.current = window.requestAnimationFrame(step);
    }, [fadingOut]);

    if (!resolvedMusicUrl) return null;

    return (
        <audio
            ref={audioRef}
            src={resolvedMusicUrl}
            loop
            preload="auto"
            aria-hidden="true"
        />
    );
}
