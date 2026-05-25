// bootBackground.ts — picks a paired (image, audio) bundle for the
// boot screens (title → language picker → menu). The same image and
// audio play across all three; nothing restarts between phase swaps.
//
// Convention: drop a matching pair into `src/assets/backgrounds/`,
// e.g. `04.jpg` + `04.mp3` or `04.webm` + `04.mp3`. Files are paired
// by basename; missing audio drops the pair from rotation. When both
// image and video exist for the same slot, the video is the visual
// source of truth and the image is only a fallback poster.
//
// Rotation index comes from:
//   1. ?launch=N URL query param (set by Electron main.ts), OR
//   2. localStorage counter (browser dev mode fallback).
// See main.ts → nextLaunchCounter() for the persistence rationale.

const STORAGE_KEY = 'greenhaven.bootBgIndex';

const imageMods = import.meta.glob(
    '../assets/backgrounds/*.{jpg,jpeg,png,webp}',
    {eager: true, query: '?url', import: 'default'},
) as Record<string, string>;

const audioMods = import.meta.glob(
    '../assets/backgrounds/*.{mp3,ogg,m4a}',
    {eager: true, query: '?url', import: 'default'},
) as Record<string, string>;

const videoMods = import.meta.glob(
    '../assets/backgrounds/*.{mp4,webm}',
    {eager: true, query: '?url', import: 'default'},
) as Record<string, string>;

interface BootBundle {
    image: string;
    audio: string;
    video: string | null;
}

function basename(path: string): string {
    const slash = path.lastIndexOf('/');
    const dot = path.lastIndexOf('.');
    return path.slice(slash + 1, dot >= 0 ? dot : undefined);
}

const audioByBase: Record<string, string> = {};
for (const [path, url] of Object.entries(audioMods)) {
    audioByBase[basename(path)] = url;
}

const imageByBase: Record<string, string> = {};
for (const [path, url] of Object.entries(imageMods)) {
    imageByBase[basename(path)] = url;
}

const videoByBase: Record<string, string> = {};
for (const [path, url] of Object.entries(videoMods)) {
    videoByBase[basename(path)] = url;
}

const visualBases = Array.from(
    new Set([...Object.keys(imageByBase), ...Object.keys(videoByBase)]),
).sort((a, b) => a.localeCompare(b, undefined, {numeric: true}));

const bundles: BootBundle[] = visualBases
    .map((base) => {
        const audio = audioByBase[base];
        if (!audio) return null;
        const image = imageByBase[base] ?? '';
        const video = videoByBase[base] ?? null;
        if (!image && !video) return null;
        return {image, audio, video};
    })
    .filter((b): b is BootBundle => b !== null);

function pickIndex(): number {
    if (bundles.length === 0) return -1;

    // Preferred path (Electron): main.ts maintains a monotonic launch
    // counter in userData/boot-state.json and passes it via ?launch=N.
    // localStorage can't be the source of truth in production because
    // the backend listens on an ephemeral port → every launch is a
    // different origin → fresh empty storage on the renderer side.
    try {
        const raw = new URLSearchParams(window.location.search).get('launch');
        if (raw !== null) {
            const n = parseInt(raw, 10);
            if (Number.isFinite(n)) {
                return ((n % bundles.length) + bundles.length) % bundles.length;
            }
        }
    } catch { /* noop */ }

    // Fallback (browser dev): localStorage. Origin is stable here.
    let prev = -1;
    try {
        const v = window.localStorage.getItem(STORAGE_KEY);
        if (v !== null) {
            const n = parseInt(v, 10);
            if (Number.isFinite(n)) prev = n;
        }
    } catch { /* noop */ }
    const next = ((prev + 1) % bundles.length + bundles.length) % bundles.length;
    try { window.localStorage.setItem(STORAGE_KEY, String(next)); } catch { /* noop */ }
    return next;
}

const idx = pickIndex();
const picked: BootBundle | null = idx >= 0 ? bundles[idx] ?? null : null;

export const bootBackgroundUrl: string = picked?.image ?? '';
export const bootVideoUrl: string = picked?.video ?? '';
export const bootMusicUrl: string = picked?.audio ?? '';
export const bootBundleCount: number = bundles.length;

// Side-effect: publish the image as a CSS variable so the existing
// `.title-screen__bg` rule (and anything else that wants the same
// art) can read it without prop-threading.
if (typeof document !== 'undefined' && bootBackgroundUrl) {
    document.documentElement.style.setProperty(
        '--boot-bg-url',
        `url("${bootBackgroundUrl}")`,
    );
}
