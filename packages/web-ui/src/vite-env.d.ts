/// <reference types="vite/client" />

interface ImportMetaEnv {
  // U-2 / UI-8 — set by vite.config.ts. `'web'` (default) routes
  // bridge/platform.ts to the Hono HTTP/SSE shims; `'desktop'` is
  // reserved for a future Wails target wired behind the same facade.
  readonly VITE_TARGET: 'web' | 'desktop';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
