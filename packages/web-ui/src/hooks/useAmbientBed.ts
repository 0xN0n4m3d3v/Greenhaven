// Spec 36 §A.1 — ambient-bed cross-fade hook.
//
// Subscribes to the bridge's `ambient:bed` event. On a slug change,
// fetches /api/audio/bed/:slug and Howl.fade()s drone + room-tone
// across cross_fade_ms. Foley + sting pools fire on a soft 8s timer
// using weighted picks. Master volume + mute come from localStorage
// (Settings → Audio tab).

import {useEffect, useRef} from 'react';
import {Howl} from 'howler';
import {fetchBedConfig} from '../bridge/audio';
import {EventsOn} from '../bridge/platform';
import {clampUnitInterval} from '../lib/audioVolume';

function pickWeighted<T extends {p: number}>(pool: T[]): T | null {
  for (const item of pool) if (Math.random() < item.p) return item;
  return null;
}

function crossFadeTo(
  ref: {current: Howl | null},
  url: string | null,
  targetVol: number,
  ms: number,
): void {
  const target = clampUnitInterval(targetVol);
  const prev = ref.current;
  if (!url) {
    if (prev) prev.fade(clampUnitInterval(prev.volume()), 0, ms);
    ref.current = null;
    return;
  }
  const next = new Howl({src: [url], loop: true, volume: 0});
  next.play();
  next.fade(0, target, ms);
  if (prev) {
    prev.fade(clampUnitInterval(prev.volume()), 0, ms);
    setTimeout(() => prev.unload(), ms);
  }
  ref.current = next;
}

export function useAmbientBed(volume: number, muted: boolean): void {
  const droneRef = useRef<Howl | null>(null);
  const roomRef = useRef<Howl | null>(null);
  const foleyTimerRef = useRef<number | null>(null);
  const muteRef = useRef(muted);
  const volRef = useRef(volume);
  useEffect(() => {
    muteRef.current = muted;
  }, [muted]);
  useEffect(() => {
    // Persisted volume comes from localStorage / Settings; clamp at
    // the boundary so a corrupted entry or negative prop can never
    // reach Howler / HTMLMediaElement.
    const safeVolume = clampUnitInterval(volume);
    volRef.current = safeVolume;
    droneRef.current?.volume(clampUnitInterval(muted ? 0 : safeVolume * 0.4));
    roomRef.current?.volume(clampUnitInterval(muted ? 0 : safeVolume * 0.6));
  }, [volume, muted]);

  useEffect(() => {
    let cancelled = false;
    const off = EventsOn('ambient:bed', async (...args: unknown[]) => {
      const payload = args[0] as {slug?: string} | undefined;
      if (!payload?.slug || cancelled) return;
      const cfg = await fetchBedConfig({slug: payload.slug});
      if (cancelled || !cfg) return;
      const v = muteRef.current ? 0 : volRef.current;
      crossFadeTo(droneRef, cfg.drone_url, v * 0.4, cfg.cross_fade_ms);
      crossFadeTo(roomRef, cfg.room_tone_url, v * 0.6, cfg.cross_fade_ms);
      if (foleyTimerRef.current) window.clearInterval(foleyTimerRef.current);
      foleyTimerRef.current = window.setInterval(() => {
        if (muteRef.current) return;
        const foley = pickWeighted(cfg!.foley_pool);
        if (foley) {
          new Howl({
            src: [foley.url],
            volume: clampUnitInterval(volRef.current * 0.5),
          }).play();
        }
        const sting = pickWeighted(cfg!.sting_pool);
        if (sting) {
          new Howl({
            src: [sting.url],
            volume: clampUnitInterval(volRef.current * 0.7),
          }).play();
        }
      }, 8000);
    });
    return () => {
      cancelled = true;
      off();
      droneRef.current?.unload();
      roomRef.current?.unload();
      droneRef.current = null;
      roomRef.current = null;
      if (foleyTimerRef.current) {
        window.clearInterval(foleyTimerRef.current);
        foleyTimerRef.current = null;
      }
    };
  }, []);
}

// U-1 — `normalizeBedConfig` now lives in `../bridge/audio` so the
// hook stays focused on the cross-fade orchestration.
