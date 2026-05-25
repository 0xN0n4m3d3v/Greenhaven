import path from 'node:path';
import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// U-2 / UI-8 — `VITE_TARGET` controls which platform `bridge/platform.ts`
// is compiled for. The web/dev build defaults to `web` (Hono HTTP/SSE
// shims under `bridge/api.ts` + in-process pub/sub in `bridge/runtime.ts`);
// a desktop target may set `VITE_TARGET=desktop` to wire the same facade
// to the Wails runtime/bus. The env value is replaced at build time so
// consumers can branch via `import.meta.env.VITE_TARGET` without leaking
// `wailsjs/*` imports past the facade.
const VITE_TARGET = process.env.VITE_TARGET ?? 'web';

export default defineConfig({
  plugins: [tailwindcss(), react()],
  define: {
    'import.meta.env.VITE_TARGET': JSON.stringify(VITE_TARGET),
  },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'vendor-react',
              test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/,
              priority: 70,
            },
            {
              name: 'vendor-radix',
              test: /node_modules[\\/]@radix-ui[\\/]/,
              priority: 60,
            },
            {
              name: 'vendor-motion',
              test:
                /node_modules[\\/](motion|framer-motion|motion-dom|motion-utils)[\\/]/,
              priority: 55,
            },
            {
              name: 'vendor-markdown',
              test:
                /node_modules[\\/](react-markdown|remark-|mdast-|micromark|unified|hast-|vfile|unist-|devlop|decode-named-character-reference|property-information|space-separated-tokens|comma-separated-tokens|stringify-entities|parse-entities)[\\/]/,
              priority: 50,
            },
            {
              name: 'vendor-media',
              test:
                /node_modules[\\/](howler|pixi\.js|@3d-dice|@esotericsoftware)[\\/]/,
              priority: 45,
            },
            {
              name: 'vendor-icons',
              test: /node_modules[\\/]lucide-react[\\/]/,
              priority: 40,
            },
            {
              name: 'vendor',
              test: /node_modules[\\/]/,
              priority: 10,
              maxSize: 420 * 1024,
            },
          ],
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // The Hono web-server mounts everything under /api (e.g.
      // /api/session, /api/session/:id/stream). DO NOT rewrite — pass
      // the path through verbatim. An earlier version stripped /api
      // and produced 404s because the server expected the prefix.
      '/api': {
        target: 'http://localhost:7777',
        changeOrigin: true,
      },
    },
  },
});
