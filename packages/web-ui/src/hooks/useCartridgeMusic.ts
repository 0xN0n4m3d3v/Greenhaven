import {useCallback, useEffect, useRef, useState} from 'react';
import {Howl} from 'howler';
import {EventsOn} from '../bridge/platform';
import {getLastMediaMusicDetail} from '../bridge/eventTimeline';
import {clampUnitInterval} from '../lib/audioVolume';
import {readAudioSettings} from '../lib/clientStorage';

export interface CartridgeMusicState {
  url: string | null;
  label: string | null;
  playing: boolean;
}

interface MusicPayload {
  action?: unknown;
  url?: unknown;
  format?: unknown;
  contentType?: unknown;
  label?: unknown;
  loop?: unknown;
  volume?: unknown;
}

function unwrapPayload(raw: unknown): MusicPayload {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const obj = raw as Record<string, unknown>;
  const nested = obj['payload'];
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    return nested as MusicPayload;
  }
  return obj as MusicPayload;
}

const SUPPORTED_FORMATS = new Set([
  'mp3',
  'ogg',
  'm4a',
  'wav',
  'mp4',
  'webm',
]);

const FORMAT_BY_CONTENT_TYPE: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-wav': 'wav',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
};

function normalizeFormat(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/^\./, '');
  return SUPPORTED_FORMATS.has(normalized) ? normalized : null;
}

function formatFromContentType(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const mime = value.trim().toLowerCase().split(';')[0] ?? '';
  return FORMAT_BY_CONTENT_TYPE[mime] ?? null;
}

function formatFromUrl(url: string): string | null {
  try {
    const pathname = new URL(url, window.location.href).pathname;
    const match = /\.([a-z0-9]+)$/i.exec(pathname);
    return normalizeFormat(match?.[1]);
  } catch {
    return null;
  }
}

function musicFormat(payload: MusicPayload, url: string): string {
  return (
    normalizeFormat(payload.format) ??
    formatFromContentType(payload.contentType) ??
    formatFromUrl(url) ??
    'mp3'
  );
}

export function useCartridgeMusic() {
  const howlRef = useRef<Howl | null>(null);
  const currentUrlRef = useRef<string | null>(null);
  const [state, setState] = useState<CartridgeMusicState>({
    url: null,
    label: null,
    playing: false,
  });

  const stop = useCallback(() => {
    howlRef.current?.unload();
    howlRef.current = null;
    currentUrlRef.current = null;
    setState({url: null, label: null, playing: false});
  }, []);

  const pause = useCallback(() => {
    howlRef.current?.pause();
    setState(prev => ({...prev, playing: false}));
  }, []);

  const resume = useCallback(() => {
    const howl = howlRef.current;
    if (!howl) return;
    howl.play();
    setState(prev => ({...prev, playing: true}));
  }, []);

  const play = useCallback(
    (
      url: string,
      label: string | null,
      loop: boolean,
      volume: number,
      format: string,
    ) => {
      const settings = readAudioSettings();
      const finalVolume = settings.muted
        ? 0
        : clampUnitInterval(settings.volume * volume);
      if (currentUrlRef.current !== url) {
        howlRef.current?.unload();
        howlRef.current = new Howl({
          src: [url],
          format: [format],
          loop,
          volume: finalVolume,
          html5: true,
          onloaderror: (_id, error) => {
            console.warn('[cartridge-music] load failed', {url, format, error});
          },
          onplayerror: (_id, error) => {
            console.warn('[cartridge-music] play failed', {url, format, error});
          },
        });
        currentUrlRef.current = url;
      } else {
        howlRef.current?.loop(loop);
        howlRef.current?.volume(finalVolume);
      }
      if (howlRef.current && !howlRef.current.playing()) {
        howlRef.current.play();
      }
      setState({url, label, playing: true});
    },
    [],
  );

  const handleMusicEvent = useCallback(
    (raw: unknown) => {
      const payload = unwrapPayload(raw);
      const action =
        typeof payload.action === 'string'
          ? payload.action.trim().toLowerCase()
          : '';
      if (action === 'stop') {
        stop();
        return;
      }
      if (action === 'pause') {
        pause();
        return;
      }
      if (action === 'resume') {
        resume();
        return;
      }
      if (action !== 'play' && action !== 'switch') return;
      const url = typeof payload.url === 'string' ? payload.url.trim() : '';
      if (!url) return;
      const label =
        typeof payload.label === 'string' && payload.label.trim()
          ? payload.label.trim()
          : null;
      const loop = typeof payload.loop === 'boolean' ? payload.loop : true;
      const volume =
        typeof payload.volume === 'number' && Number.isFinite(payload.volume)
          ? clampUnitInterval(payload.volume)
          : 1;
      play(url, label, loop, volume, musicFormat(payload, url));
    },
    [pause, play, resume, stop],
  );

  useEffect(() => {
    const off = EventsOn('media:music', handleMusicEvent);
    const latest = getLastMediaMusicDetail();
    if (latest) handleMusicEvent(latest);
    return () => {
      off();
      howlRef.current?.unload();
      howlRef.current = null;
      currentUrlRef.current = null;
    };
  }, [handleMusicEvent]);

  return {state, pause, resume, stop};
}
